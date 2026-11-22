import Match from "../models/Match.js";
import mongoose from "mongoose";
import User from "../models/User.js";
import Gameweek from "../models/Gameweek.js";
import Fixture from "../models/Fixtures.js"
import Team from "../models/Team.js";
import FantasyTeam from "../models/Felteam.js";
import { computePointsForMatch } from "./fantasy.js";

import Player from "../models/Player.js" // Import User model if not already imported
import { createError } from "../error.js";
import { publishMatchUpdate } from "../utils/liveMatchEvents.js";
// your function if any


/* -----------------------------------------
   Helpers: id validation / normalization
   ----------------------------------------- */
const isValidId = (v) => {
  try {
    if (!v) return false;
    return mongoose.Types.ObjectId.isValid(String(v));
  } catch (e) {
    return false;
  }
};

function toObjectId(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (isValidId(id)) return new mongoose.Types.ObjectId(String(id));
  return null;
}

// safe equality check for ids (works if inputs are ObjectId, string, or object with _id)
function idEquals(a, b) {
  const A = toObjectId(a);
  const B = toObjectId(b);
  if (!A || !B) return false;
  return String(A) === String(B);
}

function isKnockoutStage(stage) {
  return ["playoff", "semifinal", "final"].includes(String(stage || "").toLowerCase());
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function subtractNonNegative(current, delta) {
  return Math.max(0, asNumber(current) - asNumber(delta));
}

async function getMatchStage(matchId, session) {
  const fixtureDoc = await Fixture.findOne({ match: matchId }).populate("gameweek").session(session).lean().exec();
  return fixtureDoc?.gameweek?.stage || "regular";
}

async function revertFantasyForMatch(match, session) {
  const matchId = String(match._id);
  const fixture = await Fixture.findOne({ match: match._id }).populate("gameweek", "number competitionId").session(session).lean().exec();
  const revertedGameweek = Number(fixture?.gameweek?.number || match.gameweek || 0) || null;

  const players = await Player.find({ "fantasyStats.match": match._id }).session(session).exec();
  let revertedPlayerCount = 0;

  for (const player of players) {
    const removedEntries = (player.fantasyStats || []).filter((entry) => String(entry.match) === matchId);
    if (!removedEntries.length) continue;

    const removedPoints = removedEntries.reduce((sum, entry) => sum + asNumber(entry.points), 0);
    player.fantasyStats = (player.fantasyStats || []).filter((entry) => String(entry.match) !== matchId);
    player.totalFantasyPoints = subtractNonNegative(player.totalFantasyPoints, removedPoints);
    for (const entry of removedEntries) {
      if (!entry.competitionId) continue;
      const key = String(entry.competitionId);
      const current = typeof player.competitionFantasyPoints?.get === "function"
        ? player.competitionFantasyPoints.get(key)
        : player.competitionFantasyPoints?.[key];
      if (typeof player.competitionFantasyPoints?.set === "function") {
        player.competitionFantasyPoints.set(key, subtractNonNegative(current, entry.points));
      } else {
        player.competitionFantasyPoints = { ...(player.competitionFantasyPoints || {}), [key]: subtractNonNegative(current, entry.points) };
      }
    }
    player.markModified?.("competitionFantasyPoints");
    await player.save({ session });
    revertedPlayerCount += 1;
  }

  const fantasyTeams = await FantasyTeam.find({ [`matchPoints.${matchId}`]: { $exists: true } }).session(session).exec();
  let revertedFantasyTeamCount = 0;

  for (const team of fantasyTeams) {
    const matchPointsObj =
      typeof team.matchPoints?.get === "function"
        ? Object.fromEntries(team.matchPoints.entries())
        : { ...(team.matchPoints || {}) };

    if (!Object.prototype.hasOwnProperty.call(matchPointsObj, matchId)) continue;

    delete matchPointsObj[matchId];

    // Undo any automatic substitutions/vice-captain resolution that was
    // applied after this gameweek finished; the remaining matches will be
    // rescored below against the original locked lineup.
    if (revertedGameweek) {
      const key = String(revertedGameweek);
      const map = team.lineupSnapshots;
      const prior = typeof map?.get === "function" ? map.get(key) : map?.[key];
      if (prior) {
        const snapshot = prior.toObject ? prior.toObject() : { ...prior };
        delete snapshot.resolvedStarting;
        delete snapshot.resolvedCaptain;
        if (typeof map?.set === "function") map.set(key, snapshot);
        else team.lineupSnapshots = { ...(team.lineupSnapshots || {}), [key]: snapshot };
      }
    }

    const newGwTotals = {};
    for (const value of Object.values(matchPointsObj)) {
      const gwKey = value && value.gameweek != null ? String(value.gameweek) : null;
      if (!gwKey) continue;
      newGwTotals[gwKey] = asNumber(newGwTotals[gwKey]) + asNumber(value.points);
    }

    team.matchPoints = matchPointsObj;
    team.gameweekPoints = newGwTotals;
    team.points = Object.values(newGwTotals).reduce((sum, pts) => sum + asNumber(pts), 0);

    if (typeof team.markModified === "function") {
      team.markModified("matchPoints");
      team.markModified("gameweekPoints");
      team.markModified("lineupSnapshots");
    }

    await team.save({ session });
    revertedFantasyTeamCount += 1;
  }

  match.fantasyProcessed = false;
  match.fantasyTeamPoints = {};

  return { revertedPlayerCount, revertedFantasyTeamCount, revertedGameweek, competitionId: fixture?.competitionId || fixture?.gameweek?.competitionId || null };
}

async function revertStandingsForMatch(match, session) {
  const homeTeam = match.homeTeam ? await Team.findById(match.homeTeam).session(session) : null;
  const awayTeam = match.awayTeam ? await Team.findById(match.awayTeam).session(session) : null;

  if (!homeTeam || !awayTeam) {
    return { standingsReverted: false };
  }

  const fixture = await Fixture.findOne({ match: match._id }).session(session).lean().exec();
  // A prior season's table is frozen at rollover. Reverting an old match must
  // not subtract its result from the live season counters.
  if (fixture?.competitionId && homeTeam.competitionId && String(fixture.competitionId) !== String(homeTeam.competitionId)) {
    return { standingsReverted: false, archivedSeason: true };
  }
  const stage = await getMatchStage(match._id, session);
  const affectsTable = !isKnockoutStage(stage);
  const homeGoals = (match.goals || []).filter((g) => g.team && idEquals(g.team, homeTeam._id)).length;
  const awayGoals = (match.goals || []).filter((g) => g.team && idEquals(g.team, awayTeam._id)).length;

  homeTeam.overallGoalsFor = subtractNonNegative(homeTeam.overallGoalsFor, homeGoals);
  homeTeam.overallGoalsAgainst = subtractNonNegative(homeTeam.overallGoalsAgainst, awayGoals);
  awayTeam.overallGoalsFor = subtractNonNegative(awayTeam.overallGoalsFor, awayGoals);
  awayTeam.overallGoalsAgainst = subtractNonNegative(awayTeam.overallGoalsAgainst, homeGoals);
  homeTeam.overallMatchesPlayed = subtractNonNegative(homeTeam.overallMatchesPlayed, 1);
  awayTeam.overallMatchesPlayed = subtractNonNegative(awayTeam.overallMatchesPlayed, 1);

  if (affectsTable) {
    homeTeam.goalsFor = subtractNonNegative(homeTeam.goalsFor, homeGoals);
    homeTeam.goalsAgainst = subtractNonNegative(homeTeam.goalsAgainst, awayGoals);
    awayTeam.goalsFor = subtractNonNegative(awayTeam.goalsFor, awayGoals);
    awayTeam.goalsAgainst = subtractNonNegative(awayTeam.goalsAgainst, homeGoals);
    homeTeam.matchesPlayed = subtractNonNegative(homeTeam.matchesPlayed, 1);
    awayTeam.matchesPlayed = subtractNonNegative(awayTeam.matchesPlayed, 1);
  }

  if (homeGoals > awayGoals) {
    homeTeam.overallWins = subtractNonNegative(homeTeam.overallWins, 1);
    homeTeam.overallPoints = subtractNonNegative(homeTeam.overallPoints, 3);
    awayTeam.overallLosses = subtractNonNegative(awayTeam.overallLosses, 1);
    if (affectsTable) {
      homeTeam.wins = subtractNonNegative(homeTeam.wins, 1);
      homeTeam.points = subtractNonNegative(homeTeam.points, 3);
      awayTeam.losses = subtractNonNegative(awayTeam.losses, 1);
    }
  } else if (homeGoals < awayGoals) {
    awayTeam.overallWins = subtractNonNegative(awayTeam.overallWins, 1);
    awayTeam.overallPoints = subtractNonNegative(awayTeam.overallPoints, 3);
    homeTeam.overallLosses = subtractNonNegative(homeTeam.overallLosses, 1);
    if (affectsTable) {
      awayTeam.wins = subtractNonNegative(awayTeam.wins, 1);
      awayTeam.points = subtractNonNegative(awayTeam.points, 3);
      homeTeam.losses = subtractNonNegative(homeTeam.losses, 1);
    }
  } else {
    homeTeam.overallDraws = subtractNonNegative(homeTeam.overallDraws, 1);
    awayTeam.overallDraws = subtractNonNegative(awayTeam.overallDraws, 1);
    homeTeam.overallPoints = subtractNonNegative(homeTeam.overallPoints, 1);
    awayTeam.overallPoints = subtractNonNegative(awayTeam.overallPoints, 1);
    if (affectsTable) {
      homeTeam.draws = subtractNonNegative(homeTeam.draws, 1);
      awayTeam.draws = subtractNonNegative(awayTeam.draws, 1);
      homeTeam.points = subtractNonNegative(homeTeam.points, 1);
      awayTeam.points = subtractNonNegative(awayTeam.points, 1);
    }
  }

  await homeTeam.save({ session });
  await awayTeam.save({ session });

  return { standingsReverted: true, affectsTable, homeGoals, awayGoals };
}

export const revertMatchFulltime = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.user?.id;
    if (!userId) {
      await session.abortTransaction();
      session.endSession();
      return next(createError(401, "Not authenticated"));
    }

    const user = await User.findById(userId).session(session).lean().exec();
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return next(createError(404, "User not found"));
    }
    if (user.role !== "admin") {
      await session.abortTransaction();
      session.endSession();
      return next(createError(403, "You are not authorized to revert matches"));
    }

    const matchId = req.params.id || req.body.matchId;
    if (!matchId || !isValidId(matchId)) {
      await session.abortTransaction();
      session.endSession();
      return next(createError(400, "Valid matchId is required"));
    }

    const match = await Match.findById(matchId).session(session);
    if (!match) {
      await session.abortTransaction();
      session.endSession();
      return next(createError(404, "Match not found"));
    }

    const wasFulltime = !!match.fulltime;
    const standingsResult = wasFulltime
      ? await revertStandingsForMatch(match, session)
      : { standingsReverted: false };
    const fantasyResult = await revertFantasyForMatch(match, session);

    match.fulltime = false;
    if (typeof match.recomputeScoresFromGoals === "function") {
      match.recomputeScoresFromGoals();
    }
    await match.save({ session });

    await session.commitTransaction();
    session.endSession();

    if (fantasyResult.revertedGameweek && fantasyResult.competitionId) {
      const fixtureRows = await Fixture.find({ competitionId: fantasyResult.competitionId }).populate("gameweek", "number").select("match gameweek").lean().exec();
      const replayIds = fixtureRows.filter((row) => Number(row.gameweek?.number) === fantasyResult.revertedGameweek && row.match && String(row.match) !== String(match._id)).map((row) => row.match);
      const replayMatches = await Match.find({ _id: { $in: replayIds }, fulltime: true }).select("_id").lean().exec();
      for (const replay of replayMatches) {
        try { await computePointsForMatch(replay._id); }
        catch (error) { console.error("Error rebuilding fantasy totals after full-time revert:", error); }
      }
    }

    publishMatchUpdate(match._id, { matchId: String(match._id), type: "fulltime-reverted", updatedAt: new Date().toISOString() });

    return res.status(200).json({
      success: true,
      message: "Match full-time status and fantasy points reverted",
      data: {
        matchId: String(match._id),
        wasFulltime,
        fulltime: false,
        ...standingsResult,
        ...fantasyResult,
      },
    });
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch (e) {
      /* ignore */
    }
    session.endSession();
    console.error("Error reverting match fulltime:", error);
    return next(createError(500, "Error reverting match fulltime"));
  }
};

/**
 * updateMatch: full update handler (goals, cards, subs, matchRatings, lineup, bench, manOftheMatch, scalars)
 */
export const updateMatch = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // --- Auth & admin check ---
    const userId = req.user?.id;
    if (!userId) {
      await session.abortTransaction();
      session.endSession();
      return next(createError(401, "Not authenticated"));
    }
    const user = await User.findById(userId).session(session).lean().exec();
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return next(createError(404, "User not found"));
    }
    if (user.role !== "admin") {
      await session.abortTransaction();
      session.endSession();
      return next(createError(403, "You are not authorized to update matches"));
    }

    const { matchId, updateData } = req.body;
    if (!matchId || !isValidId(matchId)) {
      await session.abortTransaction();
      session.endSession();
      return next(createError(400, "Valid matchId is required"));
    }
    if (!updateData || typeof updateData !== "object") {
      await session.abortTransaction();
      session.endSession();
      return next(createError(400, "updateData required"));
    }

    // --- Load match for update ---
    const match = await Match.findById(matchId).session(session);
    if (!match) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: "Match not found" });
    }

    // Keep previous fulltime state to detect transitions (because we set scalarFields later)
    const wasFulltime = !!match.fulltime;

    // Prevent adding goals if already fulltime
    if (wasFulltime && Array.isArray(updateData.goals) && updateData.goals.length > 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ success: false, message: "Goals cannot be added after match is full-time" });
    }

    // Ensure arrays exist
    match.goals = Array.isArray(match.goals) ? match.goals : [];
    match.cards = Array.isArray(match.cards) ? match.cards : [];
    match.substitutions = Array.isArray(match.substitutions) ? match.substitutions : [];
    match.matchRatings = Array.isArray(match.matchRatings) ? match.matchRatings : [];

    // Convenience objectIds for home/away (normalized)
    const homeId = toObjectId(typeof match.homeTeam === "object" ? match.homeTeam._id : match.homeTeam);
    const awayId = toObjectId(typeof match.awayTeam === "object" ? match.awayTeam._id : match.awayTeam);

    // helper to resolve incoming team values (returns ObjectId or null)
    const resolveIncomingTeam = (val) => {
      if (!val && val !== 0) return null;

      // If it's an object that looks like a Mongoose doc or has _id, use that
      if (typeof val === "object") {
        if (val._id) return toObjectId(val._id);
        // sometimes client may send { side: 'home' } or { team: 'away' }
        const maybe = String(val.side ?? val.team ?? "").trim();
        if (maybe) {
          const lower = maybe.toLowerCase();
          if (lower === "home" || lower === "h") return homeId;
          if (lower === "away" || lower === "a") return awayId;
        }
      }

      // handle simple strings (case-insensitive)
      const txt = String(val).trim();
      const lower = txt.toLowerCase();
      if (lower === "home" || lower === "h") return homeId;
      if (lower === "away" || lower === "a") return awayId;

      // if it's an objectId string
      if (isValidId(txt)) return toObjectId(txt);

      return null;
    };

    // --------------------------
    // 1) Goals (robust handling incl own goals)
    // --------------------------
    if (Array.isArray(updateData.goals) && updateData.goals.length > 0) {
      for (const g of updateData.goals) {
        const minute = typeof g.minute === "number" ? g.minute : null;
        const ownGoalFlag = !!g.ownGoal;

        // resolve team from payload
        let incomingTeamId = resolveIncomingTeam(g.team);

        // resolve scorer & assist ids safely
        const scorerId = isValidId(g.scorer) ? toObjectId(g.scorer) : null;
        const assistId = isValidId(g.assist) ? toObjectId(g.assist) : null;

        // if team not provided, try to infer from scorer's 'team' property
        if (!incomingTeamId && scorerId) {
          const scorerDoc = await Player.findById(scorerId).session(session).lean().exec();
          if (scorerDoc?.team) incomingTeamId = toObjectId(scorerDoc.team);
        }

        // fallback if still missing - prefer homeId
        if (!incomingTeamId) {
          incomingTeamId = homeId;
        }

        // determine beneficiary (team that gets the goal on scoreboard)
        let beneficiaryTeamId = incomingTeamId;
        if (ownGoalFlag) {
          // beneficiary is the opponent of incomingTeamId
          if (idEquals(incomingTeamId, homeId)) beneficiaryTeamId = awayId;
          else beneficiaryTeamId = homeId;
        }

        // build DB object to push
        const goalObj = {
          minute,
          team: beneficiaryTeamId ? toObjectId(beneficiaryTeamId) : null,
          scorer: ownGoalFlag ? null : scorerId,
          assist: assistId || null,
          ownGoal: ownGoalFlag,
          ownBy: ownGoalFlag ? (scorerId || null) : null,
        };

        match.goals.push(goalObj);

        // update player stats for non-own goals
        if (!ownGoalFlag) {
          if (scorerId) {
            const scorer = await Player.findById(scorerId).session(session);
            if (scorer) {
              scorer.goals = (scorer.goals || 0) + 1;
              let perf = (scorer.matchPerformances || []).find((p) => p.match && String(p.match) === String(match._id));
              if (perf) perf.goals = (perf.goals || 0) + 1;
              else scorer.matchPerformances = (scorer.matchPerformances || []).concat([{ match: match._id, goals: 1 }]);
              await scorer.save({ session });
            }
          }

          if (assistId) {
            const assister = await Player.findById(assistId).session(session);
            if (assister) {
              assister.assists = (assister.assists || 0) + 1;
              let perf = (assister.matchPerformances || []).find((p) => p.match && String(p.match) === String(match._id));
              if (perf) perf.assists = (perf.assists || 0) + 1;
              else assister.matchPerformances = (assister.matchPerformances || []).concat([{ match: match._id, assists: 1 }]);
              await assister.save({ session });
            }
          }
        } else {
          // optional: increment own goal count on player if desired
        }
      } // end for
    } // end if goals

    // --------------------------
    // 2) Cards
    // --------------------------
    if (Array.isArray(updateData.cards) && updateData.cards.length > 0) {
      for (const card of updateData.cards) {
        const minute = typeof card.minute === "number" ? card.minute : null;
        const cardTeam = resolveIncomingTeam(card.team);
        const playerId = isValidId(card.player) ? toObjectId(card.player) : null;
        const type = card.type === "Red" ? "Red" : "Yellow";

        match.cards.push({ minute, team: cardTeam, player: playerId, type });

        // update player stats
        if (playerId) {
          const pl = await Player.findById(playerId).session(session);
          if (pl) {
            let perf = (pl.matchPerformances || []).find((p) => p.match && String(p.match) === String(match._id));
            if (!perf) {
              perf = { match: match._id, goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false };
              pl.matchPerformances = (pl.matchPerformances || []).concat([perf]);
            }
            if (type === "Yellow") {
              pl.totalyellowCards = (pl.totalyellowCards || 0) + 1;
              perf.yellowCards = (perf.yellowCards || 0) + 1;
              if (perf.yellowCards === 2) {
                pl.totalredCards = (pl.totalredCards || 0) + 1;
                pl.matchBan = (pl.matchBan || 0) + 1;
                perf.redCard = true;
              }
            } else {
              pl.totalredCards = (pl.totalredCards || 0) + 1;
              pl.matchBan = (pl.matchBan || 0) + 3;
              perf.redCard = true;
            }
            await pl.save({ session });
          }
        }
      }
    }

    // --------------------------
    // 3) Substitutions
    // --------------------------
    if (Array.isArray(updateData.substitutions) && updateData.substitutions.length > 0) {
      for (const s of updateData.substitutions) {
        const minute = typeof s.minute === "number" ? s.minute : null;
        const teamId = resolveIncomingTeam(s.team);
        const playerIn = isValidId(s.playerIn) ? toObjectId(s.playerIn) : null;
        const playerOut = isValidId(s.playerOut) ? toObjectId(s.playerOut) : null;
        match.substitutions.push({ minute, team: teamId, playerIn, playerOut });

        if (playerIn) {
          const pIn = await Player.findById(playerIn).session(session);
          if (pIn) {
            let perf = (pIn.matchPerformances || []).find((p) => p.match && String(p.match) === String(match._id));
            if (!perf) {
              pIn.matchPerformances = (pIn.matchPerformances || []).concat([{ match: match._id }]);
              await pIn.save({ session });
            }
          }
        }
      }
    }

    // --------------------------
    // 4) matchRatings and manOftheMatch
    // --------------------------
    if (Array.isArray(updateData.matchRatings) && updateData.matchRatings.length > 0) {
      for (const r of updateData.matchRatings) {
        if (!isValidId(r.player)) continue;
        match.matchRatings.push({ player: toObjectId(r.player), rating: r.rating ?? null });
        const pl = await Player.findById(String(r.player)).session(session);
        if (pl) {
          pl.matchRatings = (pl.matchRatings || []).concat([{ match: match._id, rating: r.rating }]);
          await pl.save({ session });
        }
      }
    }

    if (updateData.manOftheMatch && isValidId(updateData.manOftheMatch)) {
      match.manOftheMatch = toObjectId(updateData.manOftheMatch);
      const motm = await Player.findById(String(updateData.manOftheMatch)).session(session);
      if (motm) {
        let perf = (motm.matchPerformances || []).find((p) => p.match && String(p.match) === String(match._id));
        if (!perf) motm.matchPerformances = (motm.matchPerformances || []).concat([{ match: match._id, manOfTheMatch: true }]);
        else perf.manOfTheMatch = true;
        await motm.save({ session });
      }
    }

    // --------------------------
    // 5) Lineups & Bench
    //    Accepts:
    //      updateData.lineups = { home: [ids|obj], away: [ids|obj] }
    //      updateData.bench = { home: [ids|obj], away: [ids|obj] }
    // --------------------------
    if (updateData.lineups && typeof updateData.lineups === "object") {
      const oldHomeLineup = (match.lineups?.home || []).map((id) => String(id?._id || id));
      const oldAwayLineup = (match.lineups?.away || []).map((id) => String(id?._id || id));
      // normalize arrays of ids
      const homeArr = Array.isArray(updateData.lineups.home)
        ? updateData.lineups.home.map((x) => (typeof x === "object" && x._id ? x._id : x)).filter(isValidId).map(toObjectId)
        : undefined;
      const awayArr = Array.isArray(updateData.lineups.away)
        ? updateData.lineups.away.map((x) => (typeof x === "object" && x._id ? x._id : x)).filter(isValidId).map(toObjectId)
        : undefined;

      match.lineups = match.lineups || {};
      if (Array.isArray(homeArr)) match.lineups.home = homeArr;
      if (Array.isArray(awayArr)) match.lineups.away = awayArr;

      // ensure each listed player has a matchPerformances entry (so lineup presence is recorded)
      const ensurePerfFor = async (playerId) => {
        if (!playerId) return;
        const pl = await Player.findById(playerId).session(session);
        if (!pl) return;
        let perf = (pl.matchPerformances || []).find((p) => p.match && String(p.match) === String(match._id));
        if (!perf) {
          pl.matchPerformances = (pl.matchPerformances || []).concat([{ match: match._id }]);
          await pl.save({ session });
        }
      };
      if (Array.isArray(homeArr)) {
        for (const pid of homeArr) await ensurePerfFor(pid);
      }
      if (Array.isArray(awayArr)) {
        for (const pid of awayArr) await ensurePerfFor(pid);
      }

      const removeUnusedAppearance = async (playerId) => {
        const id = String(playerId);
        const stillInLineup = [...(match.lineups?.home || []), ...(match.lineups?.away || [])].some((entry) => String(entry?._id || entry) === id);
        const hasMatchAction = (match.goals || []).some((event) => [event.scorer, event.assist, event.ownBy].some((entry) => entry && String(entry?._id || entry) === id))
          || (match.cards || []).some((event) => String(event.player?._id || event.player) === id)
          || (match.substitutions || []).some((event) => [event.playerIn, event.playerOut].some((entry) => entry && String(entry?._id || entry) === id))
          || String(match.manOftheMatch?._id || match.manOftheMatch || "") === id;
        if (stillInLineup || hasMatchAction) return;
        const player = await Player.findById(playerId).session(session);
        if (!player) return;
        const countBefore = (player.matchPerformances || []).length;
        player.matchPerformances = (player.matchPerformances || []).filter((performance) => String(performance.match) !== String(match._id));
        if (player.matchPerformances.length !== countBefore) await player.save({ session });
      };
      const homeNow = new Set((match.lineups?.home || []).map((id) => String(id?._id || id)));
      const awayNow = new Set((match.lineups?.away || []).map((id) => String(id?._id || id)));
      for (const id of oldHomeLineup) if (Array.isArray(homeArr) && !homeNow.has(id)) await removeUnusedAppearance(id);
      for (const id of oldAwayLineup) if (Array.isArray(awayArr) && !awayNow.has(id)) await removeUnusedAppearance(id);
    }

    if (updateData.formations && typeof updateData.formations === "object") {
      const allowedFormations = new Set(["", "4-4-2", "4-3-3", "4-2-3-1", "4-5-1", "3-5-2", "3-4-3", "5-3-2", "5-4-1"]);
      match.formations = match.formations || {};
      for (const side of ["home", "away"]) {
        const formation = String(updateData.formations[side] || "");
        if (allowedFormations.has(formation)) match.formations[side] = formation;
      }
    }

    if (updateData.bench && typeof updateData.bench === "object") {
      const homeBenchArr = Array.isArray(updateData.bench.home)
        ? updateData.bench.home.map((x) => (typeof x === "object" && x._id ? x._id : x)).filter(isValidId).map(toObjectId)
        : undefined;
      const awayBenchArr = Array.isArray(updateData.bench.away)
        ? updateData.bench.away.map((x) => (typeof x === "object" && x._id ? x._id : x)).filter(isValidId).map(toObjectId)
        : undefined;

      match.bench = match.bench || {};
      if (Array.isArray(homeBenchArr)) match.bench.home = homeBenchArr;
      if (Array.isArray(awayBenchArr)) match.bench.away = awayBenchArr;

      // A named substitute has not appeared until they are actually used.
      const removeUnusedBenchEntry = async (playerId) => {
        if (!playerId) return;
        const pl = await Player.findById(playerId).session(session);
        if (!pl) return;
        const id = String(playerId);
        const inStartingXI = [...(match.lineups?.home || []), ...(match.lineups?.away || [])].some((entry) => String(entry?._id || entry) === id);
        const hasAction = (match.goals || []).some((event) => [event.scorer, event.assist, event.ownBy].some((entry) => entry && String(entry?._id || entry) === id))
          || (match.cards || []).some((event) => String(event.player?._id || event.player) === id)
          || (match.substitutions || []).some((event) => [event.playerIn, event.playerOut].some((entry) => entry && String(entry?._id || entry) === id))
          || String(match.manOftheMatch?._id || match.manOftheMatch || "") === id;
        if (inStartingXI || hasAction) return;
        const before = (pl.matchPerformances || []).length;
        pl.matchPerformances = (pl.matchPerformances || []).filter((performance) => String(performance.match) !== String(match._id));
        if (pl.matchPerformances.length !== before) await pl.save({ session });
      };
      if (Array.isArray(homeBenchArr)) {
        for (const pid of homeBenchArr) await removeUnusedBenchEntry(pid);
      }
      if (Array.isArray(awayBenchArr)) {
        for (const pid of awayBenchArr) await removeUnusedBenchEntry(pid);
      }
    }

    // --------------------------
    // 6) Timeline refs (if ObjectIds sent)
    // --------------------------
    if (Array.isArray(updateData.timeline) && updateData.timeline.length > 0) {
      for (const t of updateData.timeline) {
        if (isValidId(t)) {
          match.timeline = match.timeline || [];
          match.timeline.push(toObjectId(t));
        } else if (t && t._id && isValidId(t._id)) {
          match.timeline = match.timeline || [];
          match.timeline.push(toObjectId(t._id));
        }
      }
    }

    // --------------------------
    // 7) Scalar fields (date, venue, result, teams, fulltime)
    // --------------------------
    const scalarFields = ["date", "venue", "result", "homeTeam", "awayTeam", "fulltime"];
    for (const f of scalarFields) {
      if (Object.prototype.hasOwnProperty.call(updateData, f)) {
        if ((f === "homeTeam" || f === "awayTeam") && isValidId(updateData[f])) {
          match[f] = toObjectId(updateData[f]);
        } else {
          match[f] = updateData[f];
        }
      }
    }

    // --------------------------
    // 8) Recompute home/away score and result from match.goals (beneficiary team)
    // --------------------------
    try {
      // Use schema method if available to centralize logic:
      if (typeof match.recomputeScoresFromGoals === "function") {
        try {
          match.recomputeScoresFromGoals();
        } catch (e) {
          // fallback to manual computation
          // eslint-disable-next-line no-console
          console.warn("recomputeScoresFromGoals threw, falling back to manual computation:", e);
          const normalizedHomeId = toObjectId(typeof match.homeTeam === "object" ? match.homeTeam._id : match.homeTeam);
          const normalizedAwayId = toObjectId(typeof match.awayTeam === "object" ? match.awayTeam._id : match.awayTeam);
          let homeScore = 0;
          let awayScore = 0;
          for (const gg of match.goals || []) {
            if (!gg || !gg.team) continue;
            if (idEquals(gg.team, normalizedHomeId)) homeScore += 1;
            else if (idEquals(gg.team, normalizedAwayId)) awayScore += 1;
          }
          match.homeScore = homeScore;
          match.awayScore = awayScore;
          match.result = `${homeScore}-${awayScore}`;
        }
      } else {
        // manual compute
        const normalizedHomeId = toObjectId(typeof match.homeTeam === "object" ? match.homeTeam._id : match.homeTeam);
        const normalizedAwayId = toObjectId(typeof match.awayTeam === "object" ? match.awayTeam._id : match.awayTeam);
        let homeScore = 0;
        let awayScore = 0;
        for (const gg of match.goals || []) {
          if (!gg || !gg.team) continue;
          if (idEquals(gg.team, normalizedHomeId)) homeScore += 1;
          else if (idEquals(gg.team, normalizedAwayId)) awayScore += 1;
        }
        match.homeScore = homeScore;
        match.awayScore = awayScore;
        match.result = `${homeScore}-${awayScore}`;
      }
    } catch (e) {
      console.warn("Failed to recompute score:", e);
    }

    // finally save match within session
    await match.save({ session });

    // --------------------------
    // 9) If marking fulltime -> update team standings then commit, compute fantasy points outside transaction
    //    use wasFulltime to detect newly-marked fulltime
    // --------------------------
    const nowFulltime = !!match.fulltime;
    const justMarkedFulltime = (updateData.fulltime === true && !wasFulltime) || (!wasFulltime && nowFulltime);
    const fantasyDataChanged = ["goals", "cards", "substitutions", "lineups", "manOftheMatch", "homeScore", "awayScore"].some((key) => Object.prototype.hasOwnProperty.call(updateData, key));
    const shouldRecomputeFantasy = nowFulltime && (justMarkedFulltime || fantasyDataChanged);

    if (justMarkedFulltime) {
      // ensure match.fulltime true already (scalar step may have set it)
      match.fulltime = true;
      await match.save({ session });

      const fixtureDoc = await Fixture.findOne({ match: match._id }).populate("gameweek").session(session).lean().exec();
      const stage = fixtureDoc?.gameweek?.stage || "regular";
      const affectsTable = !isKnockoutStage(stage);

      const homeTeam = match.homeTeam ? await Team.findById(match.homeTeam).session(session) : null;
      const awayTeam = match.awayTeam ? await Team.findById(match.awayTeam).session(session) : null;

      const matchBelongsToCurrentSeason = !fixtureDoc?.competitionId
        || !homeTeam?.competitionId
        || String(fixtureDoc.competitionId) === String(homeTeam.competitionId);
      if (homeTeam && awayTeam && matchBelongsToCurrentSeason) {
        // Count goals using idEquals
        const homeGoals = (match.goals || []).filter((g) => g.team && idEquals(g.team, homeTeam._id)).length;
        const awayGoals = (match.goals || []).filter((g) => g.team && idEquals(g.team, awayTeam._id)).length;

        if (homeTeam.overallMatchesPlayed == null) homeTeam.overallMatchesPlayed = homeTeam.matchesPlayed || 0;
        if (homeTeam.overallWins == null) homeTeam.overallWins = homeTeam.wins || 0;
        if (homeTeam.overallDraws == null) homeTeam.overallDraws = homeTeam.draws || 0;
        if (homeTeam.overallLosses == null) homeTeam.overallLosses = homeTeam.losses || 0;
        if (homeTeam.overallGoalsFor == null) homeTeam.overallGoalsFor = homeTeam.goalsFor || 0;
        if (homeTeam.overallGoalsAgainst == null) homeTeam.overallGoalsAgainst = homeTeam.goalsAgainst || 0;
        if (homeTeam.overallPoints == null) homeTeam.overallPoints = homeTeam.points || 0;

        if (awayTeam.overallMatchesPlayed == null) awayTeam.overallMatchesPlayed = awayTeam.matchesPlayed || 0;
        if (awayTeam.overallWins == null) awayTeam.overallWins = awayTeam.wins || 0;
        if (awayTeam.overallDraws == null) awayTeam.overallDraws = awayTeam.draws || 0;
        if (awayTeam.overallLosses == null) awayTeam.overallLosses = awayTeam.losses || 0;
        if (awayTeam.overallGoalsFor == null) awayTeam.overallGoalsFor = awayTeam.goalsFor || 0;
        if (awayTeam.overallGoalsAgainst == null) awayTeam.overallGoalsAgainst = awayTeam.goalsAgainst || 0;
        if (awayTeam.overallPoints == null) awayTeam.overallPoints = awayTeam.points || 0;

        homeTeam.overallGoalsFor = (homeTeam.overallGoalsFor || 0) + homeGoals;
        homeTeam.overallGoalsAgainst = (homeTeam.overallGoalsAgainst || 0) + awayGoals;
        awayTeam.overallGoalsFor = (awayTeam.overallGoalsFor || 0) + awayGoals;
        awayTeam.overallGoalsAgainst = (awayTeam.overallGoalsAgainst || 0) + homeGoals;
        if (affectsTable) {
          homeTeam.goalsFor = (homeTeam.goalsFor || 0) + homeGoals;
          homeTeam.goalsAgainst = (homeTeam.goalsAgainst || 0) + awayGoals;
          awayTeam.goalsFor = (awayTeam.goalsFor || 0) + awayGoals;
          awayTeam.goalsAgainst = (awayTeam.goalsAgainst || 0) + homeGoals;
        }

        if (homeGoals > awayGoals) {
          homeTeam.overallWins = (homeTeam.overallWins || 0) + 1;
          homeTeam.overallPoints = (homeTeam.overallPoints || 0) + 3;
          awayTeam.overallLosses = (awayTeam.overallLosses || 0) + 1;
          if (affectsTable) {
          homeTeam.wins = (homeTeam.wins || 0) + 1;
          homeTeam.points = (homeTeam.points || 0) + 3;
          awayTeam.losses = (awayTeam.losses || 0) + 1;
          }
        } else if (homeGoals < awayGoals) {
          awayTeam.overallWins = (awayTeam.overallWins || 0) + 1;
          awayTeam.overallPoints = (awayTeam.overallPoints || 0) + 3;
          homeTeam.overallLosses = (homeTeam.overallLosses || 0) + 1;
          if (affectsTable) {
          awayTeam.wins = (awayTeam.wins || 0) + 1;
          awayTeam.points = (awayTeam.points || 0) + 3;
          homeTeam.losses = (homeTeam.losses || 0) + 1;
          }
        } else {
          homeTeam.overallDraws = (homeTeam.overallDraws || 0) + 1;
          awayTeam.overallDraws = (awayTeam.overallDraws || 0) + 1;
          homeTeam.overallPoints = (homeTeam.overallPoints || 0) + 1;
          awayTeam.overallPoints = (awayTeam.overallPoints || 0) + 1;
          if (affectsTable) {
          homeTeam.draws = (homeTeam.draws || 0) + 1;
          awayTeam.draws = (awayTeam.draws || 0) + 1;
          homeTeam.points = (homeTeam.points || 0) + 1;
          awayTeam.points = (awayTeam.points || 0) + 1;
          }
        }

        homeTeam.overallMatchesPlayed = (homeTeam.overallMatchesPlayed || 0) + 1;
        awayTeam.overallMatchesPlayed = (awayTeam.overallMatchesPlayed || 0) + 1;
        if (affectsTable) {
        homeTeam.matchesPlayed = (homeTeam.matchesPlayed || 0) + 1;
        awayTeam.matchesPlayed = (awayTeam.matchesPlayed || 0) + 1;
        }

        await homeTeam.save({ session });
        await awayTeam.save({ session });
      }
    }

    // commit transaction first
    await session.commitTransaction();
    session.endSession();

    // Recalculate also when an official corrects match events after full time.
    if (shouldRecomputeFantasy) {
      try {
        await computePointsForMatch(match._id);
      } catch (err) {
        console.error("Error computing fantasy points for match:", err);
      }
    }

    const liveType = updateData.goals ? "goal" : updateData.cards ? "card" : updateData.substitutions ? "substitution" : updateData.fulltime === true ? "fulltime" : "update";
    publishMatchUpdate(match._id, { matchId: String(match._id), type: liveType, updatedAt: new Date().toISOString() });

    // return populated match (include lineups, bench, manOftheMatch)
    const populated = await Match.findById(match._id)
      .populate("homeTeam", "name logo")
      .populate("awayTeam", "name logo")
      .populate({
        path: "goals",
        populate: [
          { path: "scorer", select: "name number position team" },
          { path: "assist", select: "name number position team" },
          { path: "ownBy", select: "name number position team" },
        ],
      })
      .populate({ path: "cards.player", select: "name number position team" })
      .populate({ path: "substitutions.playerIn substitutions.playerOut", select: "name number position team" })
      .populate({ path: "lineups.home lineups.away", select: "name number position team" })
      .populate({ path: "bench.home bench.away", select: "name number position team" })
      .populate({ path: "manOftheMatch", select: "name number position team" })
      .lean()
      .exec();

    return res.status(200).json({ success: true, data: populated });
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch (e) {
      /* ignore */
    }
    session.endSession();
    console.error("Error updating match:", error);
    return next(createError(500, "Error updating match"));
  }
};




/**
 * createTimeline: accepts multipart form with images (Cloudinary upload logic should be in your route or a helper)
 * - expects req.body.matchId, title, description, highlight flag, and files in req.files (if using multer)
 * - saves the Timeline doc and pushes its id to match.timeline
 */

export const getMatchesByTeam = async (req, res, next) => {
  try {
    const { teamId } = req.params;
    if (!teamId) return next(createError(400, "teamId required"));

    // find matches where the team is home or away
    const matchFilter = {
      $or: [{ homeTeam: teamId }, { awayTeam: teamId }],
    };
    if (req.query.competitionId) {
      const seasonMatchIds = await Fixture.find({ competitionId: req.query.competitionId }).distinct("match");
      matchFilter._id = { $in: seasonMatchIds };
    }
    const matches = await Match.find(matchFilter)
      .populate({ path: "homeTeam", model: "Team", select: "name logo" })
      .populate({ path: "awayTeam", model: "Team", select: "name logo" })
      .populate({ path: "goals.scorer", model: "Player", select: "name" })
      .populate({ path: "goals.assist", model: "Player", select: "name" })
      .sort({ date: -1 })
      .lean();

    // normalize response for client
    const out = matches.map((m) => {
      const homeTeamObj = m.homeTeam || null;
      const awayTeamObj = m.awayTeam || null;

      // compute home/away goals by comparing goal.team to home/away id
      const homeGoals = (m.goals || []).filter((g) => {
        if (!g.team) return false;
        const t = g.team.toString ? g.team.toString() : String(g.team);
        return homeTeamObj && String(homeTeamObj._id) === t;
      }).length;

      const awayGoals = (m.goals || []).filter((g) => {
        if (!g.team) return false;
        const t = g.team.toString ? g.team.toString() : String(g.team);
        return awayTeamObj && String(awayTeamObj._id) === t;
      }).length;

      return {
        _id: m._id,
        date: m.date ? new Date(m.date).toISOString() : null,
        venue: m.venue ?? null,
        fulltime: !!m.fulltime,
        result: m.fulltime ? `${homeGoals} - ${awayGoals}` : null,
        homeTeam: homeTeamObj ? { _id: homeTeamObj._id, name: homeTeamObj.name, logo: homeTeamObj.logo } : null,
        awayTeam: awayTeamObj ? { _id: awayTeamObj._id, name: awayTeamObj.name, logo: awayTeamObj.logo } : null,
        goals: (m.goals || []).map((g) => ({
          minute: g.minute,
          team: g.team,
          scorer: g.scorer ? (g.scorer.name || String(g.scorer._id ?? g.scorer)) : null,
          assist: g.assist ? (g.assist.name || String(g.assist._id ?? g.assist)) : null,
          ownGoal: !!g.ownGoal,
        })),
      };
    });

    return res.status(200).json({ success: true, data: out });
  } catch (err) {
    console.error("getMatchesByTeam error:", err);
    next(err);
  }
};




  export const getGameweeksWithMatches = async (req, res, next) => {
  try {
    const gameweeks = await Gameweek.find(req.query.competitionId ? { competitionId: req.query.competitionId } : {}).sort({ number: 1 }).lean();

    const resultData = await Promise.all(
      gameweeks.map(async (gameweek) => {
        // load fixtures and populate match -> teams + players
        const fixtures = await Fixture.find({ _id: { $in: gameweek.fixtures } })
          .populate({
            path: "match",
            model: "Match",
            populate: [
              { path: "homeTeam", model: "Team", select: "name logo" },
              { path: "awayTeam", model: "Team", select: "name logo" },
              { path: "goals.scorer", model: "Player", select: "name" },
              { path: "goals.assist", model: "Player", select: "name" },
            ],
          })
          .lean();

        const formattedFixtures = fixtures
          .map((fixture) => {
            const match = fixture.match;
            // if no match (bye or placeholder), return a bye fixture entry
            if (!match) {
              return {
                _id: fixture._id,
                match: null,
                homeTeam: null,
                awayTeam: null,
                homeTeamlogo: null,
                awayTeamlogo: null,
                date: null,
                venue: null,
                result: null,
                goals: [],
                fulltime: false,
              };
            }

            // ensure homeTeam/awayTeam exist (defensive)
            const homeTeamObj = match.homeTeam || null;
            const awayTeamObj = match.awayTeam || null;

            // compute score if fulltime or if goals exist
            const homeGoals = (match.goals || []).filter(
              (g) => g.team && homeTeamObj && g.team.toString() === homeTeamObj._id.toString()
            ).length;

            const awayGoals = (match.goals || []).filter(
              (g) => g.team && awayTeamObj && g.team.toString() === awayTeamObj._id.toString()
            ).length;

            return {
              _id: fixture._id,
              match: match._id, // IMPORTANT: frontend expects fixture.match to exist
              homeTeam: homeTeamObj ? homeTeamObj.name : null,
              awayTeam: awayTeamObj ? awayTeamObj.name : null,
              homeTeamlogo: homeTeamObj ? homeTeamObj.logo : null,
              awayTeamlogo: awayTeamObj ? awayTeamObj.logo : null,
              date: match.date ? new Date(match.date).toISOString() : null,
              venue: match.venue || null,
              result: match.fulltime ? `${homeGoals} - ${awayGoals}` : null,
              goals: (match.goals || []).map((goal) => ({
                minute: goal.minute,
                scorer: goal.scorer ? goal.scorer.name : null,
                assist: goal.assist ? goal.assist.name : null,
              })),
              fulltime: !!match.fulltime,
            };
          })
          .filter(Boolean);

        return {
          _id: gameweek._id,
          number: gameweek.number,
          stage: gameweek.stage || "regular",
          deadline: gameweek.deadline || null,
          fixtures: formattedFixtures,
        };
      })
    );

    return res.status(200).json({ success: true, data: resultData });
  } catch (err) {
    next(err);
  }
};
   
 // controllers/matchController.js

/**
 * GET /api/match/:id
 * Returns a single match with populated teams, lineups, bench, goals, cards and substitutions.
 * Also returns a computed result field (always available) and a sample uploaded file path.
 *
 * Note: The project pre-save hook on Match recomputes homeScore/awayScore/result when saved.
 */
export const getSingleMatchById = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: "Match id required" });

    // populate lineups & bench players + team basic info + goals/cards relationships
    const match = await Match.findById(id)
      .populate({ path: "homeTeam", model: "Team", select: "name logo" })
      .populate({ path: "awayTeam", model: "Team", select: "name logo" })
      .populate({ path: "lineups.home", model: "Player", select: "_id name number position playerPic" })
      .populate({ path: "lineups.away", model: "Player", select: "_id name number position playerPic" })
      .populate({ path: "bench.home", model: "Player", select: "_id name number position playerPic" })
      .populate({ path: "bench.away", model: "Player", select: "_id name number position playerPic" })
      .populate({ path: "goals.scorer", model: "Player", select: "_id name number playerPic" })
      .populate({ path: "goals.assist", model: "Player", select: "_id name number playerPic" })
      .populate({ path: "goals.ownBy", model: "Player", select: "_id name number playerPic" })
      .populate({ path: "cards.player", model: "Player", select: "_id name number" })
      .populate({ path: "substitutions.playerIn", model: "Player", select: "_id name number" })
      .populate({ path: "substitutions.playerOut", model: "Player", select: "_id name number" })
      .lean()
      .exec();

    if (!match) {
      return res.status(404).json({ success: false, message: "Match not found" });
    }

    // Ensure home/away scores are present (pre-save hook should keep them accurate).
    // But compute a safe result string in all cases (server-visible).
    const safeHomeScore = typeof match.homeScore === "number" ? match.homeScore : 0;
    const safeAwayScore = typeof match.awayScore === "number" ? match.awayScore : 0;
    const computedResult = `${safeHomeScore}-${safeAwayScore}`;

    // Build goals array with friendly objects
    const goals = (Array.isArray(match.goals) ? match.goals : []).map((g) => {
      return {
        _id: g._id ?? null,
        minute: g.minute ?? null,
        // team is the beneficiary team (ObjectId) — when populated it may be object or id
        team: g.team ? (typeof g.team === "object" && g.team._id ? { _id: String(g.team._id), name: g.team.name } : String(g.team)) : null,
        ownGoal: !!g.ownGoal,
        // scorer is null for own goals (but may be populated if provided)
        scorer: g.scorer ? { _id: String(g.scorer._id ?? g.scorer), name: g.scorer.name ?? null, number: g.scorer.number ?? null, playerPic: g.scorer.playerPic ?? null } : null,
        assist: g.assist ? { _id: String(g.assist._id ?? g.assist), name: g.assist.name ?? null, number: g.assist.number ?? null, playerPic: g.assist.playerPic ?? null } : null,
        ownBy: g.ownBy ? { _id: String(g.ownBy._id ?? g.ownBy), name: g.ownBy.name ?? null, number: g.ownBy.number ?? null, playerPic: g.ownBy.playerPic ?? null } : null,
      };
    });

    // Cards
    const cards = (Array.isArray(match.cards) ? match.cards : []).map((c) => ({
      _id: c._id ?? null,
      minute: c.minute ?? null,
      type: c.type,
      player: c.player ? { _id: String(c.player._id ?? c.player), name: c.player.name ?? null, number: c.player.number ?? null } : null,
      team: c.team ? (typeof c.team === "object" && c.team._id ? { _id: String(c.team._id), name: c.team.name } : String(c.team)) : null,
    }));

    // Substitutions
    const substitutions = (Array.isArray(match.substitutions) ? match.substitutions : []).map((s) => ({
      _id: s._id ?? null,
      minute: s.minute ?? null,
      team: s.team ? (typeof s.team === "object" && s.team._id ? { _id: String(s.team._id), name: s.team.name } : String(s.team)) : null,
      playerIn: s.playerIn ? { _id: String(s.playerIn._id ?? s.playerIn), name: s.playerIn.name ?? null, number: s.playerIn.number ?? null } : null,
      playerOut: s.playerOut ? { _id: String(s.playerOut._id ?? s.playerOut), name: s.playerOut.name ?? null, number: s.playerOut.number ?? null } : null,
    }));

    // Lineups & bench - return arrays of players (if populated they are objects)
    const lineupHome = Array.isArray(match.lineups?.home)
      ? match.lineups.home.map((p) => (p ? { _id: String(p._id ?? p), name: p.name ?? null, number: p.number ?? null, position: p.position ?? null, playerPic: p.playerPic ?? null } : null)).filter(Boolean)
      : [];
    const lineupAway = Array.isArray(match.lineups?.away)
      ? match.lineups.away.map((p) => (p ? { _id: String(p._id ?? p), name: p.name ?? null, number: p.number ?? null, position: p.position ?? null, playerPic: p.playerPic ?? null } : null)).filter(Boolean)
      : [];
    const benchHomeArr = Array.isArray(match.bench?.home)
      ? match.bench.home.map((p) => (p ? { _id: String(p._id ?? p), name: p.name ?? null, number: p.number ?? null, position: p.position ?? null, playerPic: p.playerPic ?? null } : null)).filter(Boolean)
      : [];
    const benchAwayArr = Array.isArray(match.bench?.away)
      ? match.bench.away.map((p) => (p ? { _id: String(p._id ?? p), name: p.name ?? null, number: p.number ?? null, position: p.position ?? null, playerPic: p.playerPic ?? null } : null)).filter(Boolean)
      : [];

    // Man of the match (may be populated or id)
    const motm = match.manOftheMatch
      ? (typeof match.manOftheMatch === "object" && match.manOftheMatch._id
        ? { _id: String(match.manOftheMatch._id), name: match.manOftheMatch.name ?? null, number: match.manOftheMatch.number ?? null }
        : { _id: String(match.manOftheMatch) })
      : null;

    // Form estimate from completed results in this competition, including matches
    // where the same club appeared as either home or away.
    const fixture = await Fixture.findOne({ match: match._id }).populate("gameweek", "competitionId").lean().exec();
    const competitionId = fixture?.competitionId || fixture?.gameweek?.competitionId;
    const fixtureRows = competitionId
      ? await Fixture.find({ competitionId, match: { $ne: match._id } }).select("match").lean().exec()
      : [];
    const priorIds = fixtureRows.map((row) => row.match).filter(Boolean);
    const priorResults = priorIds.length
      ? await Match.find({ _id: { $in: priorIds }, fulltime: true, ...(match.date ? { date: { $lt: match.date } } : {}) }).select("homeTeam awayTeam homeScore awayScore date").lean().exec()
      : [];
    const formFor = (teamId) => {
      const played = priorResults.filter((result) => String(result.homeTeam) === String(teamId) || String(result.awayTeam) === String(teamId));
      let points = 0;
      let goalDifference = 0;
      for (const result of played) {
        const atHome = String(result.homeTeam) === String(teamId);
        const scored = Number(atHome ? result.homeScore : result.awayScore) || 0;
        const conceded = Number(atHome ? result.awayScore : result.homeScore) || 0;
        points += scored > conceded ? 3 : scored === conceded ? 1 : 0;
        goalDifference += scored - conceded;
      }
      const count = Math.max(played.length, 1);
      return { count: played.length, strength: 0.65 * (points / (3 * count)) + 0.35 * (0.5 + Math.tanh(goalDifference / count / 2) / 2) };
    };
    const homeForm = formFor(match.homeTeam?._id ?? match.homeTeam);
    const awayForm = formFor(match.awayTeam?._id ?? match.awayTeam);
    const formGap = homeForm.strength - awayForm.strength + 0.08;
    const drawPct = Math.round(Math.max(14, Math.min(34, (0.31 - Math.abs(formGap) * 0.25) * 100)));
    const homePct = Math.round((100 - drawPct) / (1 + Math.exp(-formGap * 5)));
    const probability = { home: homePct, draw: drawPct, away: 100 - homePct - drawPct, sampleSize: { home: homeForm.count, away: awayForm.count } };

    // Build response object
    const responseData = {
      _id: String(match._id),
      homeTeam: match.homeTeam ? { _id: String(match.homeTeam._id ?? match.homeTeam), name: match.homeTeam.name ?? null, logo: match.homeTeam.logo ?? null } : null,
      awayTeam: match.awayTeam ? { _id: String(match.awayTeam._id ?? match.awayTeam), name: match.awayTeam.name ?? null, logo: match.awayTeam.logo ?? null } : null,
      date: match.date ?? null,
      venue: match.venue ?? null,
      fulltime: !!match.fulltime,
      // always include a result to simplify client logic (server stores result too)
      result: match.result ?? computedResult,
      homeScore: safeHomeScore,
      awayScore: safeAwayScore,
      probability,
      // arrays
      goals,
      cards,
      substitutions,
      lineups: { home: lineupHome, away: lineupAway },
      formations: match.formations || { home: "", away: "" },
      bench: { home: benchHomeArr, away: benchAwayArr },
      manOftheMatch: motm,
      // timeline references if you need them
      timeline: Array.isArray(match.timeline) ? match.timeline.map((t) => String(t)) : [],
      createdAt: match.createdAt,
      updatedAt: match.updatedAt,
      
    };

    return res.status(200).json({ success: true, data: responseData });
  } catch (err) {
    console.error("getSingleMatchById error:", err);
    next(err);
  }
};

  
