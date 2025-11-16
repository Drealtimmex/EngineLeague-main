// controllers/fantasy.js
import mongoose from "mongoose";
import { createError } from "../error.js";
import User from "../models/User.js";
import Player from "../models/Player.js";
import Team from "../models/Team.js";
import Match from "../models/Match.js";
import Gameweek from "../models/Gameweek.js";
import FantasyTeam from "../models/Felteam.js";

/**
 * NOTE / Model expectations:
 * - FantasyTeam.players : [{ player: ObjectId, isStarting: Boolean, playerPrice: Number, position: String, team: ObjectId }]
 * - FantasyTeam.budget : number (initial budget)
 * - FantasyTeam.points : total points across season
 * - FantasyTeam.effectiveGameweek : number indicating first GW team applies (optional)
 * - Player.matchPerformances[] as in your model (match, goals, assists, yellowCards, redCard, manOfTheMatch)
 *
 * If your FantasyTeam model doesn't have these fields, add them.
 */

/* -----------------------
   Config: squad rules
   ----------------------- */
const SQUAD_SIZE = 15;
const GK_REQUIRED = 2; // exactly 2
const DEF_MIN = 4;
const DEF_MAX = 5;
const MID_MIN = 4;
const MID_MAX = 5;
const FWD_MIN = 2;
const FWD_MAX = 3;
const MAX_FROM_SAME_TEAM = 3;
const MAX_FREE_TRANSFERS_PER_GW = 3;

/* -----------------------
   Helpers
   ----------------------- */

/**
 * Determine which gameweek a moment (Date) falls into:
 * We consider a team created before a GW's deadline => takes effect in that GW.
 * If created after every GW.deadline (or GW.deadline null), it will take effect in the next GW
 * (or null if none exist).
 */
async function findEffectiveGameweekForTime(time = new Date()) {
  // Find the earliest gameweek whose deadline is after 'time'
  // If a GW has null deadline, ignore it for effect calculation.
  const gw = await Gameweek.findOne({ deadline: { $ne: null, $gt: time } }).sort({ number: 1 }).exec();
  if (gw) return gw.number;
  // If none found, try max number + 1 (future GW placeholder)
  const last = await Gameweek.findOne({}).sort({ number: -1 }).lean().exec();
  if (last) return last.number + 1;
  return null;
}

/**
 * Get active gameweek for "now" - the GW whose deadline is next (deadline > now) or current running GW.
 * This is used for transfers/lineups validation.
 */
async function getUpcomingGameweek() {
  const now = new Date();
  return await Gameweek.findOne({ deadline: { $ne: null, $gt: now } }).sort({ number: 1 }).exec();
}

/**
 * Validate squad composition and budget.
 * players: array of { player: ObjectId }
 * budget: available budget number (max allowed to spend)
 * existingSpending: optional number already spent (useful for transfers; defaults 0)
 *
 * Also returns enriched players map with position/team info and price to be stored.
 */
async function validateAndEnrichSquad(playersInput = [], budget = 150) {
  if (!Array.isArray(playersInput)) throw new Error("players must be an array");

  if (playersInput.length !== SQUAD_SIZE) {
    throw createError(400, `Squad must be exactly ${SQUAD_SIZE} players`);
  }

  // Load all players to validate
  const playerIds = playersInput.map((p) => new  mongoose.Types.ObjectId(p.player || p));
  const players = await Player.find({ _id: { $in: playerIds } }).populate("team").lean().exec();

  if (players.length !== SQUAD_SIZE) {
    return { valid: false, message: "Some players not found" };
  }

  const posCounts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const teamCounts = {};
  let totalPrice = 0;

  const enriched = players.map((p) => {
    // Normalize position categories
    // Your positions: CB, LB, RB => DEF ; CM, DM, AM => MID ; ST, CF, LW, RW => FWD ; GK => GK
    let cat;
    const pos = (p.position || "").toUpperCase();
    if (pos === "GK") cat = "GK";
    else if (["CB", "LB", "RB"].includes(pos)) cat = "DEF";
    else if (["CM", "DM", "AM"].includes(pos)) cat = "MID";
    else if (["ST", "CF", "LW", "RW"].includes(pos)) cat = "FWD";
    else cat = "MID"; // fallback

    posCounts[cat] = (posCounts[cat] || 0) + 1;
    const teamId = p.team ? p.team._id.toString() : "unknown";1
    teamCounts[teamId] = (teamCounts[teamId] || 0) + 1;
    // Use player's price at time of signing (player.price); ensure it exists
    const price = typeof p.price === "number" ? p.price : 10;
    totalPrice += price;

    return {
      player: p._id,
      isStarting: false,
      playerPrice: price,
      position: pos,
      team: p.team ? p.team._id : null,
    };
  });

  // Validate per-team limit
  for (const [teamId, cnt] of Object.entries(teamCounts)) {
    if (cnt > MAX_FROM_SAME_TEAM) {
      return { valid: false, message: `You cannot have more than ${MAX_FROM_SAME_TEAM} players from the same team` };
    }
  }

  // Position validations
  if (posCounts.GK !== GK_REQUIRED) return { valid: false, message: `You must have exactly ${GK_REQUIRED} goalkeepers` };
  if (posCounts.DEF < DEF_MIN || posCounts.DEF > DEF_MAX) return { valid: false, message: `Defenders must be between ${DEF_MIN}-${DEF_MAX}` };
  if (posCounts.MID < MID_MIN || posCounts.MID > MID_MAX) return { valid: false, message: `Midfielders must be between ${MID_MIN}-${MID_MAX}` };
  if (posCounts.FWD < FWD_MIN || posCounts.FWD > FWD_MAX) return { valid: false, message: `Forwards must be between ${FWD_MIN}-${FWD_MAX}` };

  if (totalPrice > budget) return { valid: false, message: `Total squad cost ${totalPrice} exceeds budget ${budget}` };

  return { valid: true, enriched, totalPrice };
}

/* -----------------------
   Controller actions
   ----------------------- */

/**
 * Create fantasy team
 * Body: { teamName, players: [{player: playerId}], teamLogo?, budget?, competitionId? }
 */
export const createFantasyTeam = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { teamName, players, teamLogo, budget = 150, competitionId } = req.body;
    if (!teamName) return next(createError(400, "teamName required"));
    if (!players || !Array.isArray(players)) return next(createError(400, "players array required"));
    const checking = await FantasyTeam.findOne({ user:userId})
    if(checking) return next(createError(400, "teamalready created"))
    // Validate/enrich squad
    const validation = await validateAndEnrichSquad(players, budget);
    if (!validation.valid) return next(createError(400, validation.message));

    // Determine effective gameweek
    const createdAt = new Date();
    const effectiveGameweek = await findEffectiveGameweekForTime(createdAt);

    const ft = new FantasyTeam({
      user: userId,
      teamName,
      teamLogo: teamLogo || null,
      players: validation.enriched,
      budget,
      points: 0,
      competitionId: competitionId || null,
      createdAt,
      effectiveGameweek,
      transfers: {
        lastResetGw: effectiveGameweek, // track when transfers were last reset
        freeTransfersUsedInGw: 0
      }
    });

    const saved = await ft.save();

    return res.status(201).json({ success: true, data: saved });
  } catch (err) {
    console.error("[createFantasyTeam] error:", err);
    next(err);
  }
};

/**
 * Edit fantasy team metadata (team name, logo) or replace entire squad BEFORE effective deadline.
 * Body: { fantasyTeamId, teamName?, teamLogo?, players? }
 * Editing players uses same validations as create and must be done before the upcoming GW deadline
 */
export const editFantasyTeam = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { fantasyTeamId, teamName, teamLogo, players } = req.body;
    if (!fantasyTeamId) return next(createError(400, "fantasyTeamId required"));

    const team = await FantasyTeam.findById(fantasyTeamId);
    if (!team) return next(createError(404, "Fantasy team not found"));
    if (team.user.toString() !== userId) return next(createError(403, "Not authorized"));

    // transfers/edits deadline: must be before upcoming gameweek deadline OR before the team's effective GW deadline
    const upcomingGW = await getUpcomingGameweek();
    const now = new Date();

    if (upcomingGW && upcomingGW.deadline) {
      // If now >= deadline, edits for that GW are closed.
      if (now >= upcomingGW.deadline) {
        return next(createError(403, "Cannot edit squad after gameweek deadline"));
      }
    }

    // If players provided, validate
    if (players) {
      const validation = await validateAndEnrichSquad(players, team.budget);
      if (!validation.valid) return next(createError(400, validation.message));
      // replace players
      team.players = validation.enriched;
    }

    if (teamName) team.teamName = teamName;
    if (teamLogo) team.teamLogo = teamLogo;

    await team.save();
    return res.status(200).json({ success: true, data: team });
  } catch (err) {
    console.error("[editFantasyTeam] error:", err);
    next(err);
  }
};

/**
 * Make transfers
 * Body: { fantasyTeamId, transfers: [{ out: playerIdOut, in: playerIdIn }] }
 *
 * - Up to MAX_FREE_TRANSFERS_PER_GW per gameweek free (this logic counts freeTransfersUsedInGw)
 * - Each transfer pair counts as one transfer
 * - Replacing player retains original playerPrice for bookkeeping (we store playerPrice for new incoming player)
 * - Validate budget and squad rules after transfers.
 */
export const makeTransfers = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { fantasyTeamId, transfers } = req.body;
    if (!fantasyTeamId || !Array.isArray(transfers)) return next(createError(400, "fantasyTeamId and transfers required"));

    const team = await FantasyTeam.findById(fantasyTeamId);
    if (!team) return next(createError(404, "Fantasy team not found"));
    if (team.user.toString() !== userId) return next(createError(403, "Not authorized"));

    // Determine current upcoming GW and its deadline; transfers locked after deadline
    const upcomingGW = await getUpcomingGameweek();
    const now = new Date();
    if (!upcomingGW || !upcomingGW.deadline) {
      // If no GW found (edge case), prevent transfers
      return next(createError(400, "No active gameweek found for transfers"));
    }
    if (now >= upcomingGW.deadline) {
      return next(createError(403, "Transfers are closed for the current gameweek"));
    }

    // Reset freeTransfersUsedInGw if the team.lastResetGw < upcomingGW.number
    if (!team.transfers) team.transfers = { lastResetGw: upcomingGW.number, freeTransfersUsedInGw: 0 };
    if (team.transfers.lastResetGw !== upcomingGW.number) {
      team.transfers.lastResetGw = upcomingGW.number;
      team.transfers.freeTransfersUsedInGw = 0;
    }

    const numRequested = transfers.length;
    const freeLeft = Math.max(0, MAX_FREE_TRANSFERS_PER_GW - (team.transfers.freeTransfersUsedInGw || 0));
    if (numRequested > freeLeft) {
      return next(createError(400, `You have ${freeLeft} free transfers left for this gameweek`));
    }

    // Build current roster map
    const roster = team.players.map((p) => ({ ...p.toObject ? p.toObject() : p, player: p.player ? p.player.toString() : p.player }));
    const rosterMap = new Map(roster.map((r) => [r.player.toString(), r]));

    // For each transfer, validate out exists and in not already in roster
    const outIds = transfers.map((t) => t.out.toString());
    const inIds = transfers.map((t) => t.in.toString());

    for (const outId of outIds) {
      if (!rosterMap.has(outId)) return next(createError(400, "Attempting to remove player not in squad"));
    }
    for (const inId of inIds) {
      if (rosterMap.has(inId)) return next(createError(400, "Incoming player already in squad"));
    }

    // Load incoming players to get price/team/position
    const incomingPlayers = await Player.find({ _id: { $in: inIds } }).populate("team").lean().exec();
    if (incomingPlayers.length !== inIds.length) return next(createError(404, "Some incoming players not found"));

    // Prepare new roster array by removing outs and adding ins
    let newRoster = roster.filter((r) => !outIds.includes(r.player.toString()));
    // Add incoming enriched items
    for (const p of incomingPlayers) {
      newRoster.push({
        player: p._id,
        isStarting: false,
        playerPrice: p.price || 10, // price locked at signing time
        position: p.position,
        team: p.team ? p.team._id : null,
      });
    }

    // Validate new roster constraints & budget
    const simplifiedPlayers = newRoster.map((r) => ({ player: r.player }));
    const validation = await validateAndEnrichSquad(simplifiedPlayers, team.budget);
    if (!validation.valid) return next(createError(400, validation.message));

    // Replace team.players with new roster but keep old players' playerPrice if a player was already in squad earlier
    // (we already used incoming player's current price as their locked price)
    team.players = validation.enriched;

    // Update free transfers used
    team.transfers.freeTransfersUsedInGw = (team.transfers.freeTransfersUsedInGw || 0) + numRequested;

    await team.save();
    return res.status(200).json({ success: true, data: team });
  } catch (err) {
    console.error("[makeTransfers] error:", err);
    next(err);
  }
};

/**
 * Set lineup and captain/vice-captain before deadline.
 * Body: { fantasyTeamId, startingPlayerIds: [playerId... 11 total], captain: playerId, viceCaptain: playerId }
 *
 * Rules:
 * - Starting players must be from team's roster
 * - Exactly 11 starting players (we don't strictly validate formation here beyond counts)
 * - Captain must be among starting players
 */
export const setLineup = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { fantasyTeamId, startingPlayerIds, captain, viceCaptain } = req.body;
    if (!fantasyTeamId) return next(createError(400, "fantasyTeamId required"));
    if (!Array.isArray(startingPlayerIds) || startingPlayerIds.length !== 11) return next(createError(400, "startingPlayerIds must be an array of 11 player ids"));
    if (!captain) return next(createError(400, "captain required"));

    const team = await FantasyTeam.findById(fantasyTeamId);
    if (!team) return next(createError(404, "Fantasy team not found"));
    if (team.user.toString() !== userId) return next(createError(403, "Not authorized"));

    // Check upcoming GW deadline
    const upcomingGW = await getUpcomingGameweek();
    const now = new Date();
    if (!upcomingGW || !upcomingGW.deadline) return next(createError(400, "No active gameweek"));
    if (now >= upcomingGW.deadline) return next(createError(403, "Cannot set lineup after deadline"));

    // roster set
    const rosterIds = team.players.map((p) => p.player.toString());
    for (const sid of startingPlayerIds) {
      if (!rosterIds.includes(sid.toString())) return next(createError(400, "Starting players must be from your roster"));
    }
    if (!startingPlayerIds.includes(captain)) return next(createError(400, "Captain must be among starting players"));

    // Update isStarting flags
    team.players = team.players.map((p) => {
      const id = p.player.toString();
      return {
        ...p.toObject ? p.toObject() : p,
        isStarting: startingPlayerIds.includes(id),
      };
    });

    team.captain = captain;
    team.viceCaptain = viceCaptain || null;
    team.lastLineupSetAt = now;

    await team.save();
    return res.status(200).json({ success: true, data: team });
  } catch (err) {
    console.error("[setLineup] error:", err);
    next(err);
  }
};

/**
 * Get all fantasy teams (optionally filter by competition or user)
 * Query params: userId?, competitionId?
 */
export const getAllFantasyTeams = async (req, res, next) => {
  try {
    const { userId, competitionId } = req.query;
    const filter = {};
    if (userId) filter.user = userId;
    if (competitionId) filter.competitionId = competitionId;
    const teams = await FantasyTeam.find(filter).populate("user", "username email").populate("players.player", "name position team price").exec();
    return res.status(200).json({ success: true, data: teams });
  } catch (err) {
    console.error("[getAllFantasyTeams] error:", err);
    next(err);
  }
};

/**
 * Get single fantasy team
 */
export const getFantasyTeamById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const team = await FantasyTeam.findById(id).populate("user", "username email").populate("players.player", "name position team price").exec();
    if (!team) return next(createError(404, "Fantasy team not found"));
    return res.status(200).json({ success: true, data: team });
  } catch (err) {
    console.error("[getFantasyTeamById] error:", err);
    next(err);
  }
};
export const getFantasyTeamByLoggedId = async (req, res, next) => {
  try {
    const user = req.user.id
    const team = await FantasyTeam.findOne( {user:user}).populate("user", "username email").populate("players.player", "name position team price").exec();
    if (!team) return next(createError(404, "Fantasy team not found"));
    return res.status(200).json({ success: true, data: team });
  } catch (err) {
    console.error("[getFantasyTeamById] error:", err);
    next(err);
  }
};

/* -----------------------
   Points calculation helpers
   ----------------------- */

/**
 * Calculate points for a single player's performance in a match.
 * Rules used (based on your spec, adjustable):
 * - Appearance: 0 if did not play. If started => +5, if substitute came on => +2
 * - Goal by non-keeper: +4 each
 * - Assist: +3 each
 * - Man of the Match: +6
 * - Yellow card: -2 each
 * - Red card: -4 each
 * - Clean sheet: For GK and DEF only, +4 if their team concedes 0 goals (we will use -1 per conceded goal per your note: implement as -1 per conceded goal)
 *   You specified "-1 for every goal conceded" for defenders and keeper: we'll apply -1 per conceded goal to each defender & GK (this is harsher than typical FPL).
 * - Captain multiplier: x2
 *
 * IMPORTANT: These rules follow your written description. Adjust weights if you prefer FPL typical scoring.
 */
function calculatePlayerMatchPoints(performance = {}, playerPosition = "MID", concededGoals = 0, started = false, subOn = false) {
  let pts = 0;

  if (started) pts += 5;
  else if (subOn) pts += 2;
  // goals
  if (performance.goals) pts += 4 * performance.goals;
  // assists
  if (performance.assists) pts += 3 * performance.assists;
  // man of match
  if (performance.manOfTheMatch) pts += 6;
  // cards
  if (performance.yellowCards) pts -= 2 * performance.yellowCards;
  if (performance.redCard) pts -= 4;
  // conceded goals penalty for defenders & keepers: -1 per goal conceded
  if (["GK", "DEF"].includes(playerPosition)) pts -= concededGoals * 1;

  return pts;
}

/**teP
 * Compute and distribute points when a match goes fulltime.
 * This function:
 * - looks up matchPerformances for the match,
 * - for each fantasy team that has players involved and whose team was effective for the relevant GW, adds points to their GW and to the team's total.
 *
 * NOTE: For efficiency in production you probably want incremental DB queries / bulk updates. This implementation is straightforward and correct.
 */
export async function computePointsForMatch(matchId) {
  try {
    const match = await Match.findById(matchId)
      .populate("homeTeam")
      .populate("awayTeam")
      .lean()
      .exec();

    if (!match) {
      console.warn("[computePointsForMatch] match not found:", matchId);
      return;
    }

    // Count conceded goals for each team
    const homeGoals = (match.goals || []).filter((g) => g.team && g.team.toString() === match.homeTeam._id.toString()).length;
    const awayGoals = (match.goals || []).filter((g) => g.team && g.team.toString() === match.awayTeam._id.toString()).length;

    // Build map of playerId -> performance
    const perfByPlayer = {};
    (match.goals || []).forEach((g) => {
      if (g.scorer) {
        const sid = g.scorer.toString();
        perfByPlayer[sid] = perfByPlayer[sid] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
        perfByPlayer[sid].goals += 1;
      }
      if (g.assist) {
        const aid = g.assist.toString();
        perfByPlayer[aid] = perfByPlayer[aid] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
        perfByPlayer[aid].assists += 1;
      }
    });

    (match.cards || []).forEach((c) => {
      if (!c.player) return;
      const pid = c.player.toString();
      perfByPlayer[pid] = perfByPlayer[pid] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
      if (c.type === "Yellow") perfByPlayer[pid].yellowCards += 1;
      if (c.type === "Red") perfByPlayer[pid].redCard = true;
    });

    if (match.manOftheMatch) {
      const motm = match.manOftheMatch.toString();
      perfByPlayer[motm] = perfByPlayer[motm] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
      perfByPlayer[motm].manOfTheMatch = true;
    }

    (match.lineups?.home || []).forEach((p) => {
      const id = p.toString();
      perfByPlayer[id] = perfByPlayer[id] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
      perfByPlayer[id].started = true;
    });
    (match.lineups?.away || []).forEach((p) => {
      const id = p.toString();
      perfByPlayer[id] = perfByPlayer[id] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
      perfByPlayer[id].started = true;
    });
    (match.substitutions || []).forEach((s) => {
      if (s.playerIn) {
        const id = s.playerIn.toString();
        perfByPlayer[id] = perfByPlayer[id] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
        perfByPlayer[id].subOn = true;
      }
    });

    const playerIds = Object.keys(perfByPlayer);
    if (playerIds.length === 0) {
      // nothing to compute for players
      return;
    }

    // load players
    const players = await Player.find({ _id: { $in: playerIds } }).populate("team").lean().exec();
    const playerMap = {};
    players.forEach((p) => { playerMap[p._id.toString()] = p; });

    // find gameweek number containing this match (if any)
    let gw = await Gameweek.findOne({ fixtures: match._id }).lean().exec();
    let gameweekNumber = gw ? gw.number : null;
    if (!gameweekNumber && match.date) {
      const gwByDate = await Gameweek.findOne({ deadline: { $gt: new Date(match.date) } }).sort({ number: 1 }).lean().exec();
      if (gwByDate) gameweekNumber = gwByDate.number;
    }

    // compute player points map
    const playerPoints = {}; // pid -> points
    for (const pid of playerIds) {
      const perf = perfByPlayer[pid];
      const p = playerMap[pid];
      if (!p) continue;

      // position normalisation
      let posCat = "MID";
      const pos = (p.position || "").toUpperCase();
      if (pos === "GK") posCat = "GK";
      else if (["CB","LB","RB"].includes(pos)) posCat = "DEF";
      else if (["CM","DM","AM"].includes(pos)) posCat = "MID";
      else if (["ST","CF","LW","RW"].includes(pos)) posCat = "FWD";

      const playerTeamId = p.team ? p.team._id.toString() : null;
      const conceded = (playerTeamId === match.homeTeam._id.toString()) ? awayGoals : homeGoals;

      const pts = calculatePlayerMatchPoints(perf, posCat, conceded, perf.started, perf.subOn);
      playerPoints[pid] = pts;
    }

    // Persist player fantasy stats (idempotent): for each player, add fantasyStats entry for this match if not existing
    const playerBulkOps = [];
    for (const [pid, pts] of Object.entries(playerPoints)) {
      // use upsert logic: only push new entry if no existing entry for this match
      playerBulkOps.push({
        updateOne: {
          filter: { _id:new mongoose.Types.ObjectId(pid), "fantasyStats.match": { $ne:new mongoose.Types.ObjectId(match._id) } },
          update: {
            $push: { fantasyStats: { match: match._id, gameweek: gameweekNumber, points: pts } },
            $inc: { totalFantasyPoints: pts }
          }
        }
      });
    }
    if (playerBulkOps.length > 0) {
      await Player.bulkWrite(playerBulkOps);
      // note: entries for players already having fantasyStats for this match will not be updated by above filter
    }

    // Now distribute points to fantasy teams (existing logic)
    const fTeams = await FantasyTeam.find({ "players.player": { $in: playerIds } }).exec();

    for (const ft of fTeams) {
      // skip if team's effectiveGameweek > gameweekNumber (not active yet)
      if (ft.effectiveGameweek && gameweekNumber && ft.effectiveGameweek > gameweekNumber) continue;

      let addToTeamTotal = 0;
      for (const pEntry of ft.players) {
        const pid = pEntry.player ? pEntry.player.toString() : null;
        if (!pid) continue;
        if (!playerPoints.hasOwnProperty(pid)) continue;

        const pPts = playerPoints[pid];

        // captain doubling
        let finalPts = pPts;
        if (ft.captain && ft.captain.toString() === pid) finalPts = finalPts * 2;

        addToTeamTotal += finalPts;

        // persist per-gameweek breakdown
        if (!ft.gameweekPoints) ft.gameweekPoints = {};
        if (!gameweekNumber) {
          ft.gameweekPoints = ft.gameweekPoints || {};
          ft.gameweekPoints[match._id.toString()] = (ft.gameweekPoints[match._id.toString()] || 0) + finalPts;
        } else {
          ft.gameweekPoints[gameweekNumber] = (ft.gameweekPoints[gameweekNumber] || 0) + finalPts;
        }
      }

      ft.points = (ft.points || 0) + addToTeamTotal;
      await ft.save();
    }

  } catch (err) {
    console.error("[computePointsForMatch] error:", err);
    throw err;
  }
}
  export const deleteTeam = async (req, res, next) => {
    const user = req.user.id
   
    
    if (user || user.role === "admin"){
      try{
        await FantasyTeam.findOneAndDelete({user:user})
        res.status(200).json("user has been deleted")
  
      }catch (err){
        next(err)
      }
    }
  
  else {
    return next(createError(403, "You are not authorized!"))
  }
  }
/* -----------------------
   Hook into match update flow
   ----------------------- */

/**
 * Export a helper to be called after match update if fulltime: compute points
 * Use in your existing updateMatch controller: after you set match.fulltime true and save, call:
 *
 *   await computePointsForMatch(match._id)
 *
 * I will not modify your entire updateMatch here, but add the call example in comments.
 */

export default {
  createFantasyTeam,
  editFantasyTeam,
  makeTransfers,
  setLineup,
  getAllFantasyTeams,
  getFantasyTeamById,
  computePointsForMatch,
};
