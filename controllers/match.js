import Match from "../models/Match.js";
import mongoose from "mongoose";
import User from "../models/User.js";
import Gameweek from "../models/Gameweek.js";
import Fixture from "../models/Fixtures.js"
import Team from "../models/Team.js";
import { computePointsForMatch } from "./fantasy.js";

import Player from "../models/Player.js" // Import User model if not already imported
import { createError } from "../error.js";
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

      // ensure bench players also have matchPerformances entry (optional but useful)
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
      if (Array.isArray(homeBenchArr)) {
        for (const pid of homeBenchArr) await ensurePerfFor(pid);
      }
      if (Array.isArray(awayBenchArr)) {
        for (const pid of awayBenchArr) await ensurePerfFor(pid);
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

    if (justMarkedFulltime) {
      // ensure match.fulltime true already (scalar step may have set it)
      match.fulltime = true;
      await match.save({ session });

      const homeTeam = match.homeTeam ? await Team.findById(match.homeTeam).session(session) : null;
      const awayTeam = match.awayTeam ? await Team.findById(match.awayTeam).session(session) : null;

      if (homeTeam && awayTeam) {
        // Count goals using idEquals
        const homeGoals = (match.goals || []).filter((g) => g.team && idEquals(g.team, homeTeam._id)).length;
        const awayGoals = (match.goals || []).filter((g) => g.team && idEquals(g.team, awayTeam._id)).length;

        homeTeam.goalsFor = (homeTeam.goalsFor || 0) + homeGoals;
        homeTeam.goalsAgainst = (homeTeam.goalsAgainst || 0) + awayGoals;
        awayTeam.goalsFor = (awayTeam.goalsFor || 0) + awayGoals;
        awayTeam.goalsAgainst = (awayTeam.goalsAgainst || 0) + homeGoals;

        if (homeGoals > awayGoals) {
          homeTeam.wins = (homeTeam.wins || 0) + 1;
          homeTeam.points = (homeTeam.points || 0) + 3;
          awayTeam.losses = (awayTeam.losses || 0) + 1;
        } else if (homeGoals < awayGoals) {
          awayTeam.wins = (awayTeam.wins || 0) + 1;
          awayTeam.points = (awayTeam.points || 0) + 3;
          homeTeam.losses = (homeTeam.losses || 0) + 1;
        } else {
          homeTeam.draws = (homeTeam.draws || 0) + 1;
          awayTeam.draws = (awayTeam.draws || 0) + 1;
          homeTeam.points = (homeTeam.points || 0) + 1;
          awayTeam.points = (awayTeam.points || 0) + 1;
        }

        homeTeam.matchesPlayed = (homeTeam.matchesPlayed || 0) + 1;
        awayTeam.matchesPlayed = (awayTeam.matchesPlayed || 0) + 1;

        await homeTeam.save({ session });
        await awayTeam.save({ session });
      }
    }

    // commit transaction first
    await session.commitTransaction();
    session.endSession();

    // compute fantasy points outside session if justMarkedFulltime
    if (justMarkedFulltime) {
      try {
        await computePointsForMatch(match._id);
      } catch (err) {
        console.error("Error computing fantasy points for match:", err);
      }
    }

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




  export const getGameweeksWithMatches = async (req, res, next) => {
  try {
    const gameweeks = await Gameweek.find().sort({ number: 1 }).lean();

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
      .populate({ path: "lineups.home", model: "Player", select: "_id name number position" })
      .populate({ path: "lineups.away", model: "Player", select: "_id name number position" })
      .populate({ path: "bench.home", model: "Player", select: "_id name number position" })
      .populate({ path: "bench.away", model: "Player", select: "_id name number position" })
      .populate({ path: "goals.scorer", model: "Player", select: "_id name number" })
      .populate({ path: "goals.assist", model: "Player", select: "_id name number" })
      .populate({ path: "goals.ownBy", model: "Player", select: "_id name number" })
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
        scorer: g.scorer ? { _id: String(g.scorer._id ?? g.scorer), name: g.scorer.name ?? null, number: g.scorer.number ?? null } : null,
        assist: g.assist ? { _id: String(g.assist._id ?? g.assist), name: g.assist.name ?? null, number: g.assist.number ?? null } : null,
        ownBy: g.ownBy ? { _id: String(g.ownBy._id ?? g.ownBy), name: g.ownBy.name ?? null, number: g.ownBy.number ?? null } : null,
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
      ? match.lineups.home.map((p) => (p ? { _id: String(p._id ?? p), name: p.name ?? null, number: p.number ?? null } : null)).filter(Boolean)
      : [];
    const lineupAway = Array.isArray(match.lineups?.away)
      ? match.lineups.away.map((p) => (p ? { _id: String(p._id ?? p), name: p.name ?? null, number: p.number ?? null } : null)).filter(Boolean)
      : [];
    const benchHomeArr = Array.isArray(match.bench?.home)
      ? match.bench.home.map((p) => (p ? { _id: String(p._id ?? p), name: p.name ?? null, number: p.number ?? null } : null)).filter(Boolean)
      : [];
    const benchAwayArr = Array.isArray(match.bench?.away)
      ? match.bench.away.map((p) => (p ? { _id: String(p._id ?? p), name: p.name ?? null, number: p.number ?? null } : null)).filter(Boolean)
      : [];

    // Man of the match (may be populated or id)
    const motm = match.manOftheMatch
      ? (typeof match.manOftheMatch === "object" && match.manOftheMatch._id
        ? { _id: String(match.manOftheMatch._id), name: match.manOftheMatch.name ?? null, number: match.manOftheMatch.number ?? null }
        : { _id: String(match.manOftheMatch) })
      : null;

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
      // arrays
      goals,
      cards,
      substitutions,
      lineups: { home: lineupHome, away: lineupAway },
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

  