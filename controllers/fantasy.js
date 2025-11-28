// controllers/fantasy.js
import mongoose from "mongoose";
import { createError } from "../error.js";
import User from "../models/User.js";
import Player from "../models/Player.js";

import Team from "../models/Team.js";
import Match from "../models/Match.js";
import Fixture from "../models/Fixtures.js";
import Gameweek from "../models/Gameweek.js";
import FantasyTeam from "../models/Felteam.js";
const { Types } = mongoose;
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
// controllers/fantasyController.js (or wherever you keep it)
// NOTE: adjust import paths/names to match your project structure


// Example export style matches your earlier code
export const makeTransfers = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { fantasyTeamId, transfers } = req.body;
    if (!fantasyTeamId || !Array.isArray(transfers)) {
      return next(createError(400, "fantasyTeamId and transfers required"));
    }

    const team = await FantasyTeam.findById(fantasyTeamId);
    if (!team) return next(createError(404, "Fantasy team not found"));
    if (String(team.user) !== String(userId)) return next(createError(403, "Not authorized"));

    // upcoming GW & deadline guard
    const upcomingGW = await getUpcomingGameweek();
    const now = new Date();
    if (!upcomingGW || !upcomingGW.deadline) {
      return next(createError(400, "No active gameweek found for transfers"));
    }
    if (now >= new Date(upcomingGW.deadline)) {
      return next(createError(403, "Transfers are closed for the current gameweek"));
    }

    // initialize/reset transfer counters for new gameweek
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

    // Build current roster map (normalize to simple objects)
    const roster = (team.players || []).map((p) => {
      const obj = p && p.toObject ? p.toObject() : { ...(p || {}) };
      const playerId = obj.player ? (typeof obj.player === "object" ? String(obj.player._id ?? obj.player) : String(obj.player)) : null;
      return {
        // keep existing fields present on team.players
        _raw: obj,
        player: playerId,
        isStarting: !!obj.isStarting,
        playerPrice: obj.playerPrice ?? obj.price ?? null,
        position: obj.position ?? (obj.player && obj.player.position) ?? null,
        team: obj.team ? (obj.team._id ? String(obj.team._id) : String(obj.team)) : null,
      };
    });

    const rosterMap = new Map(roster.map((r) => [String(r.player), r]));

    // Validate out/in ids presence and uniqueness
    const outIds = transfers.map((t) => String(t.out));
    const inIds = transfers.map((t) => String(t.in));

    // ensure outs exist in roster
    for (const outId of outIds) {
      if (!rosterMap.has(outId)) return next(createError(400, `Attempting to remove player not in squad: ${outId}`));
    }
    // ensure ins are not already in roster (can't add existing player)
    for (const inId of inIds) {
      if (rosterMap.has(inId)) return next(createError(400, `Incoming player already in squad: ${inId}`));
    }

    // load incoming players to get team/price/position metadata
    const incomingPlayers = await Player.find({ _id: { $in: inIds } }).populate("team").lean().exec();
    if (incomingPlayers.length !== inIds.length) return next(createError(404, "Some incoming players not found"));

    // Map incoming player id => player doc
    const incomingById = {};
    for (const p of incomingPlayers) incomingById[String(p._id)] = p;

    // Build newRoster: remove outs and add ins. Preserve isStarting mapping:
    // Map each transfer pair by order: transfers[i] => outIds[i] replaced by inIds[i].
    // If out was starting -> incoming will be starting.
    let newRoster = roster.filter((r) => !outIds.includes(String(r.player)));

    // Keep track of which outgoing players were captain/vice to clear if needed
    const captainStr = team.captain ? String(team.captain) : null;
    const viceStr = team.viceCaptain ? String(team.viceCaptain) : null;
    const outsSet = new Set(outIds.map(String));

    // If captain or vice are being removed, clear them
    if (captainStr && outsSet.has(captainStr)) team.captain = null;
    if (viceStr && outsSet.has(viceStr)) team.viceCaptain = null;

    // For each transfer mapping, add incoming with isStarting set to out.isStarting
    for (const tr of transfers) {
      const outId = String(tr.out);
      const inId = String(tr.in);

      const outEntry = rosterMap.get(outId);
      if (!outEntry) return next(createError(400, `Out player not found in roster: ${outId}`));

      const incomingDoc = incomingById[inId];
      if (!incomingDoc) return next(createError(404, `Incoming player not found: ${inId}`));

      // create new roster entry: set isStarting to outEntry.isStarting so incoming replaces the starter if needed
      const newEntry = {
        player: String(incomingDoc._id),
        isStarting: !!outEntry.isStarting,
        playerPrice: incomingDoc.price ?? outEntry.playerPrice ?? 0,
        position: incomingDoc.position ?? outEntry.position ?? null,
        team: incomingDoc.team ? (incomingDoc.team._id ? String(incomingDoc.team._id) : String(incomingDoc.team)) : null,
      };

      newRoster.push(newEntry);
    }

    // Defensive: roster length should remain same
    if (newRoster.length !== roster.length) {
      return next(createError(400, "Roster size mismatch after applying transfers"));
    }

    // Validate "max 3 from same real-world team"
    const teamCounts = new Map();
    for (const r of newRoster) {
      const teamIdStr = r.team ? String(r.team) : null;
      if (!teamIdStr) continue;
      const cur = teamCounts.get(teamIdStr) || 0;
      const nextCount = cur + 1;
      if (nextCount > 3) {
        return next(createError(400, "A fantasy team cannot have more than 3 players from the same real-world team"));
      }
      teamCounts.set(teamIdStr, nextCount);
    }

    // At this point, prepare simplified players array for your validator
    const simplifiedPlayers = newRoster.map((r) => ({ player: String(r.player) }));

    // Run validation/enrichment (this should return { valid: true, enriched: [...] } or { valid:false, message })
    const validation = await validateAndEnrichSquad(simplifiedPlayers, team.budget);
    if (!validation || !validation.valid) {
      const msg = validation && validation.message ? validation.message : "Squad validation failed";
      return next(createError(400, msg));
    }

    // Apply isStarting mapping to enriched entries
    // Build map of playerId -> isStarting from newRoster
    const startingMap = new Map();
    for (const r of newRoster) {
      startingMap.set(String(r.player), !!r.isStarting);
    }

    const enriched = (validation.enriched || []).map((entry) => {
      const pid = String(entry.player);
      const shouldStart = !!startingMap.get(pid);
      // ensure the enriched entry shape accepts isStarting
      return { ...entry, isStarting: shouldStart };
    });

    // Final defensive formation check: ensure starting count is 11 and formation rules satisfied
    const startingCount = enriched.filter((e) => e.isStarting).length;
    if (startingCount !== 11) {
      return next(createError(400, `After transfers, starting XI must have 11 players (found ${startingCount}).`));
    }
    // Optionally re-check positional composition using enriched entries
    const posCounts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    function normalizeShort(pos) {
      const q = (pos || "").toUpperCase();
      if (q === "GK") return "GK";
      if (["CB", "LB", "RB", "LWB", "RWB"].includes(q)) return "DEF";
      if (["CM", "DM", "AM", "LM", "RM"].includes(q)) return "MID";
      if (["ST", "CF", "LW", "RW", "FW"].includes(q)) return "FWD";
      return "MID";
    }
    for (const e of enriched) {
      if (!e.isStarting) continue;
      const cat = normalizeShort(e.position || e.playerPosition || e.pos || e.position);
      posCounts[cat] = (posCounts[cat] || 0) + 1;
    }
    if (posCounts.GK !== 1) return next(createError(400, "Starting XI must include exactly 1 GK after transfers"));
    if (posCounts.DEF < 3 || posCounts.DEF > 5) return next(createError(400, "DEF must be between 3 and 5 after transfers"));
    if (posCounts.MID < 3 || posCounts.MID > 5) return next(createError(400, "MID must be between 3 and 5 after transfers"));
    if (posCounts.FWD < 1 || posCounts.FWD > 3) return next(createError(400, "FWD must be between 1 and 3 after transfers"));

    // Replace team.players with enriched roster
    team.players = enriched;

    // Update free transfers used
    team.transfers.freeTransfersUsedInGw = (team.transfers.freeTransfersUsedInGw || 0) + numRequested;
    team.transfers.lastResetGw = upcomingGW.number;

    await team.save();

    // Return populated team so frontend receives populated player objects (and player.team)
    const populated = await FantasyTeam.findById(team._id)
      .populate({
        path: "players.player",
        select: "name position price fantasyStats team teamLogo totalFantasyPoints",
        populate: { path: "team", select: "name _id" },
      })
      .populate({ path: "user", select: "username email _id" })
      .lean();

    return res.status(200).json({ success: true, data: populated });
  } catch (err) {
    console.error("[makeTransfers] error:", err);
    return next(err);
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
// controllers/fantasyController.js (Node/Express style)

// controllers/fantasyController.js

/**
 * POST /api/fantasy/lineup  (or whatever route you use)
 * Body: { fantasyTeamId, startingPlayerIds: string[11], captain, viceCaptain?, target? }
 */
export const setLineup = async (req, res, next) => {
  try {
    const userId = req.user && (req.user.id || req.user._id);
    const { fantasyTeamId, startingPlayerIds, captain, viceCaptain, target } = req.body;

    // basic validation
    if (!fantasyTeamId) return next(createError(400, "fantasyTeamId required"));
    if (!Array.isArray(startingPlayerIds) || startingPlayerIds.length !== 11)
      return next(createError(400, "startingPlayerIds must be an array of 11 player ids"));
    if (!captain) return next(createError(400, "captain required"));

    // load team
    const team = await FantasyTeam.findById(fantasyTeamId);
    if (!team) return next(createError(404, "Fantasy team not found"));

    // owner check
    if (!userId || String(team.user) !== String(userId)) return next(createError(403, "Not authorized"));

    // roster ids (stringified)
    const rosterIds = (team.players || []).map((p) => {
      // p.player might be an ObjectId or populated object; handle both
      if (!p || typeof p !== "object") return String(p);
      const raw = p.player;
      if (!raw) return "";
      if (typeof raw === "string") return String(raw);
      if (raw._id) return String(raw._id);
      return String(raw);
    }).filter(Boolean);

    // ensure every starting id is in roster
    for (const sid of startingPlayerIds) {
      if (!rosterIds.includes(String(sid))) return next(createError(400, "Starting players must be from your roster"));
    }

    // ensure captain/vice are among starting
    const startingSet = new Set(startingPlayerIds.map(String));
    if (!startingSet.has(String(captain))) return next(createError(400, "Captain must be among starting players"));
    if (viceCaptain && !startingSet.has(String(viceCaptain))) return next(createError(400, "Vice-captain must be among starting players"));

    // determine target GW / default
    let targetGw = null;
    let isDefault = false;
    if (typeof target !== "undefined" && target !== null) {
      if (String(target).toLowerCase() === "default") {
        isDefault = true;
      } else {
        const n = Number(target);
        if (Number.isFinite(n) && n > 0) targetGw = Math.floor(n);
        else return next(createError(400, "target must be 'default' or a valid gameweek number"));
      }
    } else {
      // pick upcoming gameweek by default
      const upcoming = await getUpcomingGameweek();
      if (!upcoming || !upcoming.number) return next(createError(400, "No active gameweek"));
      targetGw = upcoming.number;
    }

    // if target is upcoming GW, check deadline guard
    const upcomingGW = await getUpcomingGameweek();
    if (targetGw && upcomingGW && targetGw === upcomingGW.number) {
      if (!upcomingGW.deadline) return next(createError(400, "No active gameweek deadline"));
      const now = new Date();
      if (now >= new Date(upcomingGW.deadline)) return next(createError(403, "Cannot set lineup after deadline for upcoming gameweek"));
    }

    // Build map playerId -> position (use position saved on team.players)
    const posMap = {};
    (team.players || []).forEach((p) => {
      const pid = p && p.player && (typeof p.player === "object" ? String(p.player._id ?? p.player) : String(p.player));
      if (pid) posMap[String(pid)] = (p.position || (p.player && p.player.position) || null);
    });

    // formation validation
    const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    function normalizePosShort(pos) {
      const q = (pos || "").toUpperCase();
      if (q === "GK") return "GK";
      if (["CB", "LB", "RB", "LWB", "RWB"].includes(q)) return "DEF";
      if (["CM", "DM", "AM", "LM", "RM"].includes(q)) return "MID";
      if (["ST", "CF", "LW", "RW", "FW"].includes(q)) return "FWD";
      return "MID";
    }
    for (const sid of startingPlayerIds) {
      const pos = posMap[String(sid)];
      const cat = normalizePosShort(pos);
      counts[cat] = (counts[cat] || 0) + 1;
    }
    if (counts.GK !== 1) return next(createError(400, "Starting XI must include exactly 1 GK"));
    if (counts.DEF < 3 || counts.DEF > 5) return next(createError(400, "DEF must be between 3 and 5"));
    if (counts.MID < 3 || counts.MID > 5) return next(createError(400, "MID must be between 3 and 5"));
    if (counts.FWD < 1 || counts.FWD > 3) return next(createError(400, "FWD must be between 1 and 3"));

    // create snapshot
    const snapshot = {
      starting: startingPlayerIds.map((id) => String(id)),
      captain: String(captain),
      viceCaptain: viceCaptain ? String(viceCaptain) : null,
      setAt: new Date(),
      isDefault: !!isDefault,
    };

    // ensure lineupSnapshots exists
    if (!team.lineupSnapshots || typeof team.lineupSnapshots !== "object") team.lineupSnapshots = {};

    if (isDefault) {
      team.lineupSnapshots["default"] = snapshot;
    } else {
      team.lineupSnapshots[String(targetGw)] = snapshot;
    }

    // update root-level captain/vice for convenience
    team.captain = String(captain);
    team.viceCaptain = viceCaptain ? String(viceCaptain) : null;

    // update players[].isStarting according to snapshot (bench = not in starting)
    const startingIdsSet = new Set(snapshot.starting.map(String));
    if (Array.isArray(team.players)) {
      team.players.forEach((entry) => {
        const pid = entry && entry.player && (typeof entry.player === "object" ? String(entry.player._id ?? entry.player) : String(entry.player));
        entry.isStarting = pid ? startingIdsSet.has(String(pid)) : false;
      });
    }

    // optionally set effectiveGameweek if it's the upcoming gw
    if (targetGw && (!team.effectiveGameweek || Number(team.effectiveGameweek) !== Number(targetGw))) {
      team.effectiveGameweek = Number(targetGw);
    }

    // persist
    await team.save();

    // return populated team (players.player and nested team populated)
    // adjust fields selected as you wish
    const populated = await FantasyTeam.findById(team._id)
      .populate({
        path: "players.player",
        select: "name position price fantasyStats team teamLogo",
        populate: { path: "team", select: "name _id" },
      })
      .populate({ path: "user", select: "username email _id" })
      .lean();

    return res.status(200).json({ success: true, data: populated });
  } catch (err) {
    console.error("[setLineup] error:", err);
    return next(err);
  }
}


 
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

/**teP
 * Compute and distribute points when a match goes fulltime.
 * This function:
 * - looks up matchPerformances for the match,
 * - for each fantasy team that has players involved and whose team was effective for the relevant GW, adds points to their GW and to the team's total.
 *
 * NOTE: For efficiency in production you probably want incremental DB queries / bulk updates. This implementation is straightforward and correct.
 */
// services/computePointsForMatch.js

/**
 * Scoring rules.
 * Tweak this function to match your exact fantasy rules.
 * Returns integer points for a single player for the match.
// services/computeFantasyPoints.js

/**
 * calculatePlayerMatchPoints
 *
 * - perf: object containing goals, assists, cards, manOfTheMatch, started, subOn
 * - posCategory: "GK"|"DEF"|"MID"|"FWD"
 * - concededGoals: number (goals conceded by player's team)
 * - started: boolean
 * - subOn: boolean
 * - teamOutcome: "win" | "draw" | "loss" | null  (applies only if player played)
 *
 * Returns integer points (rounded)
 */
export function calculatePlayerMatchPoints(perf = {}, posCategory = "MID", concededGoals = 0, started = false, subOn = false, teamOutcome = null) {
  let pts = 0;

  // Appearance bonus: starter 2, sub-on 1
  if (started) pts += 2;
  else if (subOn) pts += 1;

  // Goals
  const goals = Number(perf.goals || 0);
  if (goals > 0) {
    if (posCategory === "GK" || posCategory === "DEF") pts += 6 * goals;
    else if (posCategory === "MID") pts += 5 * goals;
    else pts += 4 * goals; // FWD
  }

  // Assists
  pts += 3 * (Number(perf.assists || 0));

  // Man of the match
  if (perf.manOfTheMatch) pts += 3;

  // Cards
  pts -= 1 * (Number(perf.yellowCards || 0));
  if (perf.redCard) pts -= 3;

  // Clean sheet
  if (started && (posCategory === "GK" || posCategory === "DEF") && Number(concededGoals || 0) === 0) pts += 4;
  if (started && posCategory === "MID" && Number(concededGoals || 0) === 0) pts += 1;

  // Team outcome bonus (apply only if player played)
  if ((started || subOn) && teamOutcome) {
    if (teamOutcome === "win") pts += 3;
    else if (teamOutcome === "draw") pts += 2;
    else if (teamOutcome === "loss") pts += 1;
  }

  return Math.round(pts);
}

/**
 * computePointsForMatch
 *
 * Main job:
 * - compute points for players involved in a Match,
 * - update Player.fantasyStats and Player.totalFantasyPoints,
 * - update FantasyTeam.matchPoints and gameweek totals and overall points,
 * - store lineup snapshot if needed.
 *
 * Returns an object with summary info on success.
 */
export async function computePointsForMatch(matchId) {
  if (!matchId) throw new Error("matchId required");

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Load match (lean) and minimal team population
    const match = await Match.findById(matchId)
      .populate("homeTeam", "_id")
      .populate("awayTeam", "_id")
      .lean()
      .exec();

    if (!match) throw new Error("Match not found: " + matchId);

    // Ensure home/away score are present (your pre-save should compute this)
    const homeScore = Number(match.homeScore ?? 0);
    const awayScore = Number(match.awayScore ?? 0);

    const homeTeamId = match.homeTeam ? String(match.homeTeam._id) : null;
    const awayTeamId = match.awayTeam ? String(match.awayTeam._id) : null;

    // Build per-player perf map from match events
    const perfByPlayer = {};
    (match.goals || []).forEach((g) => {
      if (g.scorer) {
        const sid = String(g.scorer);
        perfByPlayer[sid] = perfByPlayer[sid] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
        perfByPlayer[sid].goals += 1;
      }
      if (g.assist) {
        const aid = String(g.assist);
        perfByPlayer[aid] = perfByPlayer[aid] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
        perfByPlayer[aid].assists += 1;
      }
      // ownGoal handling: ownGoal may be recorded using ownBy — leave as is (not credited to scorer)
      if (g.ownBy) {
        const oid = String(g.ownBy);
        perfByPlayer[oid] = perfByPlayer[oid] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
        // own goals are typically penalized or treated specially — we won't add positive goals
      }
    });

    (match.cards || []).forEach((c) => {
      if (!c.player) return;
      const pid = String(c.player);
      perfByPlayer[pid] = perfByPlayer[pid] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
      if (String(c.type || "").toLowerCase().includes("yellow")) perfByPlayer[pid].yellowCards += 1;
      if (String(c.type || "").toLowerCase().includes("red")) perfByPlayer[pid].redCard = true;
    });

    if (match.manOftheMatch) {
      const motm = String(match.manOftheMatch);
      perfByPlayer[motm] = perfByPlayer[motm] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
      perfByPlayer[motm].manOfTheMatch = true;
    }

    (match.lineups?.home || []).forEach((p) => {
      const id = String(p);
      perfByPlayer[id] = perfByPlayer[id] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
      perfByPlayer[id].started = true;
    });
    (match.lineups?.away || []).forEach((p) => {
      const id = String(p);
      perfByPlayer[id] = perfByPlayer[id] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
      perfByPlayer[id].started = true;
    });

    (match.substitutions || []).forEach((s) => {
      if (s.playerIn) {
        const id = String(s.playerIn);
        perfByPlayer[id] = perfByPlayer[id] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
        perfByPlayer[id].subOn = true;
      }
      // If substitution has playerOut, ensure they exist in perf map (they probably do from lineups)
      if (s.playerOut) {
        const id = String(s.playerOut);
        perfByPlayer[id] = perfByPlayer[id] || { goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false };
      }
    });

    const playerIds = Object.keys(perfByPlayer);
    // Determine gameweekNumber
    let gameweekNumber = null;
    const fixture = await Fixture.findOne({ match: match._id }).populate("gameweek").lean().exec();
    if (fixture) {
      if (fixture.gameweek && typeof fixture.gameweek === "object" && fixture.gameweek.number != null) {
        gameweekNumber = Number(fixture.gameweek.number);
      } else if (fixture.gameweek && typeof fixture.gameweek === "string") {
        const gw = await Gameweek.findById(fixture.gameweek).lean().exec();
        if (gw) gameweekNumber = gw.number;
      }
    }
    if (gameweekNumber == null && match.gameweek != null) {
      gameweekNumber = Number(match.gameweek);
    }
    if (gameweekNumber == null) {
      const gwDoc = await Gameweek.findOne({ fixtures: match._id }).lean().exec();
      if (gwDoc) gameweekNumber = gwDoc.number;
    }
    if (gameweekNumber == null && match.date) {
      const gwByDate = await Gameweek.findOne({ deadline: { $gt: new Date(match.date) } }).sort({ number: 1 }).lean().exec();
      if (gwByDate) gameweekNumber = gwByDate.number;
    }

    // if no players in perf map: update match.gameweek if known and return early
    if (playerIds.length === 0) {
      if (gameweekNumber != null) {
        await Match.updateOne({ _id: match._id }, { $set: { gameweek: gameweekNumber } }).session(session).exec();
      }
      await session.commitTransaction();
      session.endSession();
      return { success: true, players: 0, gameweekNumber };
    }

    // load player docs for metadata (position, team)
    const players = await Player.find({ _id: { $in: playerIds } }).populate("team").lean().exec();
    const playerMap = {};
    players.forEach((p) => { playerMap[String(p._id)] = p; });

    // Determine team outcome per team id: 'win'|'draw'|'loss'
    const outcomeByTeam = {};
    if (homeTeamId) {
      if (homeScore > awayScore) outcomeByTeam[homeTeamId] = "win";
      else if (homeScore === awayScore) outcomeByTeam[homeTeamId] = "draw";
      else outcomeByTeam[homeTeamId] = "loss";
    }
    if (awayTeamId) {
      if (awayScore > homeScore) outcomeByTeam[awayTeamId] = "win";
      else if (awayScore === homeScore) outcomeByTeam[awayTeamId] = "draw";
      else outcomeByTeam[awayTeamId] = "loss";
    }

    // compute points per player
    const playerPoints = {};
    for (const pid of playerIds) {
      const perf = perfByPlayer[pid] || {};
      const p = playerMap[pid];
      if (!p) continue;

      // derive position category
      let posCat = "MID";
      const pos = String(p.position || "").toUpperCase();
      if (pos === "GK") posCat = "GK";
      else if (["CB", "LB", "RB", "LWB", "RWB"].some(x => pos.includes(x))) posCat = "DEF";
      else if (["CM", "DM", "AM", "LM", "RM"].some(x => pos.includes(x))) posCat = "MID";
      else if (["ST", "CF", "FW", "LW", "RW"].some(x => pos.includes(x))) posCat = "FWD";

      // conceded goals relative to player's team
      const playerTeamId = p.team ? String(p.team._id ?? p.team) : null;
      let conceded = 0;
      if (playerTeamId) {
        if (playerTeamId === homeTeamId) conceded = awayScore;
        else if (playerTeamId === awayTeamId) conceded = homeScore;
      }

      const teamOutcome = playerTeamId ? outcomeByTeam[playerTeamId] ?? null : null;

      const pts = calculatePlayerMatchPoints(perf, posCat, conceded, perf.started, perf.subOn, teamOutcome);
      playerPoints[pid] = pts;
    }

    // Bulk update Player.fantasyStats and totalFantasyPoints
    const playerBulkOps = [];
    for (const [pid, pts] of Object.entries(playerPoints)) {
      // push only if not already pushed for this match (idempotent check)
      playerBulkOps.push({
        updateOne: {
          filter: { _id: new mongoose.Types.ObjectId(pid), "fantasyStats.match": { $ne: new mongoose.Types.ObjectId(match._id) } },
          update: {
            $push: { fantasyStats: { match: match._id, gameweek: gameweekNumber, points: pts } },
            $inc: { totalFantasyPoints: pts },
          },
        },
      });
    }
    if (playerBulkOps.length > 0) {
      await Player.bulkWrite(playerBulkOps, { session });
    }

    // Find fantasy teams containing any affected players
    const fTeams = await FantasyTeam.find({ "players.player": { $in: playerIds } }).session(session).exec();
    const matchFantasyTeamPoints = {};

    for (const ft of fTeams) {
      // skip teams not active for that GW
      if (ft.effectiveGameweek && gameweekNumber && ft.effectiveGameweek > gameweekNumber) continue;

      // build roster map for lookup
      const rosterMap = {};
      for (const pe of ft.players || []) {
        const pid = String(pe.player);
        rosterMap[pid] = pe; // contains isStarting, position, etc
      }

      const contributors = [];
      let teamTotalForMatch = 0;

      for (const pid of Object.keys(playerPoints)) {
        if (!rosterMap[pid]) continue; // not on this fantasy team
        const pe = rosterMap[pid];
        const perf = perfByPlayer[pid] || {};
        const played = !!(pe.isStarting || perf.subOn); // count starters or those subbed on
        if (!played) continue;

        let pPts = Number(playerPoints[pid] || 0);
        const isCaptain = ft.captain && String(ft.captain) === pid;
        const isVice = ft.viceCaptain && String(ft.viceCaptain) === pid;
        if (isCaptain) pPts = pPts * 2;

        teamTotalForMatch += pPts;
        contributors.push({
          playerId: pid,
          points: Number(playerPoints[pid] || 0),
          countedPoints: pPts,
          isStarting: !!pe.isStarting,
          isCaptain: !!isCaptain,
          isVice: !!isVice,
        });
      }

      // Save matchPoints entry keyed by match._id
      const matchKey = String(match._id);
      const matchPointEntry = { points: teamTotalForMatch, gameweek: gameweekNumber, contributors };

      if (!ft.matchPoints) ft.matchPoints = {};
      if (typeof ft.matchPoints.set === "function") {
        ft.matchPoints.set(matchKey, matchPointEntry);
      } else {
        ft.matchPoints[matchKey] = matchPointEntry;
      }

      // Recompute gameweekPoints aggregator
      const newGwTotals = {};
      if (ft.matchPoints && typeof ft.matchPoints.entries === "function") {
        for (const [, val] of ft.matchPoints.entries()) {
          const gwKey = val && val.gameweek != null ? String(val.gameweek) : "null";
          newGwTotals[gwKey] = (newGwTotals[gwKey] || 0) + Number(val.points || 0);
        }
      } else {
        for (const mId of Object.keys(ft.matchPoints || {})) {
          const val = ft.matchPoints[mId];
          const gwKey = val && val.gameweek != null ? String(val.gameweek) : "null";
          newGwTotals[gwKey] = (newGwTotals[gwKey] || 0) + Number(val.points || 0);
        }
      }

      if (!ft.gameweekPoints) ft.gameweekPoints = {};
      if (typeof ft.gameweekPoints.set === "function") {
        for (const k of Object.keys(newGwTotals)) {
          if (k === "null") continue;
          ft.gameweekPoints.set(String(Number(k)), Number(newGwTotals[k] || 0));
        }
      } else {
        ft.gameweekPoints = ft.gameweekPoints || {};
        for (const k of Object.keys(newGwTotals)) {
          if (k === "null") continue;
          ft.gameweekPoints[String(Number(k))] = Number(newGwTotals[k] || 0);
        }
      }

      // recompute total points
      let recomputedTotal = 0;
      if (ft.gameweekPoints && typeof ft.gameweekPoints.entries === "function") {
        for (const [, v] of ft.gameweekPoints.entries()) recomputedTotal += Number(v || 0);
      } else {
        for (const k of Object.keys(ft.gameweekPoints || {})) recomputedTotal += Number(ft.gameweekPoints[k] || 0);
      }
      ft.points = recomputedTotal;

      // create lineup snapshot for this gameweek if not present and if current starting XI has 11 players
      try {
        if (gameweekNumber != null) {
          const gwKey = String(gameweekNumber);
          const hasSnapshot = (typeof ft.lineupSnapshots?.get === "function")
            ? ft.lineupSnapshots.has(gwKey)
            : (ft.lineupSnapshots && Object.prototype.hasOwnProperty.call(ft.lineupSnapshots, gwKey));

          const currentStarting = (ft.players || []).filter(p => !!p.isStarting).map(p => String(p.player));
          if (!hasSnapshot && currentStarting.length === 11) {
            const snapshot = {
              starting: currentStarting,
              captain: ft.captain ? String(ft.captain) : null,
              viceCaptain: ft.viceCaptain ? String(ft.viceCaptain) : null,
              setAt: new Date(),
              isDefault: false,
            };

            if (!ft.lineupSnapshots) ft.lineupSnapshots = {};
            if (typeof ft.lineupSnapshots.set === "function") {
              ft.lineupSnapshots.set(gwKey, snapshot);
            } else {
              ft.lineupSnapshots[gwKey] = snapshot;
            }
          }
        }
      } catch (snapErr) {
        console.warn("snapshot write issue (non-fatal):", snapErr);
      }

      if (typeof ft.markModified === "function") {
        ft.markModified("matchPoints");
        ft.markModified("gameweekPoints");
        ft.markModified("lineupSnapshots");
      }

      await ft.save({ session });
      matchFantasyTeamPoints[String(ft._id)] = Number(teamTotalForMatch || 0);
    }

    // Update match doc with fantasy processing info
    const matchUpdate = { fantasyProcessed: true };
    if (gameweekNumber != null) matchUpdate.gameweek = gameweekNumber;
    if (Object.keys(matchFantasyTeamPoints).length > 0) matchUpdate.fantasyTeamPoints = matchFantasyTeamPoints;
    await Match.updateOne({ _id: match._id }, { $set: matchUpdate }).session(session).exec();

    await session.commitTransaction();
    session.endSession();

    return { success: true, playerPointsCount: Object.keys(playerPoints).length, matchFantasyTeamPoints, gameweekNumber };
  } catch (err) {
    try {
      await session.abortTransaction();
      session.endSession();
    } catch (e) {
      // ignore
    }
    console.error("[computePointsForMatch] failed:", err);
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
// controllers/fantasyController.js

/**
 * Helper: normalize position to GK/DEF/MID/FWD
 */

/**
 * Count categories of a players array (expects objects of the playerEntrySchema)
 * returns { GK, DEF, MID, FWD }
 */
 function normalizePosition(pos) {
      const p = (pos || "").toUpperCase();
      if (p === "GK") return "GK";
      if (["CB", "LB", "RB", "LWB", "RWB"].includes(p)) return "DEF";
      if (["CM", "DM", "AM", "LM", "RM"].includes(p)) return "MID";
      if (["ST", "CF", "LW", "RW", "FW"].includes(p)) return "FWD";
      return "MID";
    }
   
function countByCategory(players = []) {
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of players || []) {
    const pos = p.position || (p.player && p.player.position) || "";
    const cat = normalizePosition(pos);
    if (p.isStarting) counts[cat] = (counts[cat] || 0) + 1;
  }
  return counts;
}

/**
 * Validate lineup counts and return error message if invalid, else null
 */
function validateLineupCounts(players) {
  const starting = players.filter((p) => p.isStarting);
  if (starting.length !== 11) return "Starting XI must have exactly 11 players.";
  const counts = countByCategory(players);
  if (counts.GK !== 1) return "Starting XI must have exactly 1 goalkeeper.";
  if (counts.DEF < 3 || counts.DEF > 5) return "Defenders must be between 3 and 5.";
  if (counts.MID < 3 || counts.MID > 5) return "Midfielders must be between 3 and 5.";
  if (counts.FWD < 1 || counts.FWD > 3) return "Forwards must be between 1 and 3.";
  return null;
}

/**
 * POST /api/fantasy/substitute
 * body: { fantasyTeamId, out: <playerIdOut>, in: <playerIdIn> }
 * Auth: req.user.id must be owner of the team
 */
export const substitutePlayers = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { fantasyTeamId, out: outId, in: inId } = req.body;
    if (!fantasyTeamId || !outId || !inId) return res.status(400).json({ message: "fantasyTeamId, out and in are required" });

    // Basic ObjectId validation
    if (!Types.ObjectId.isValid(fantasyTeamId) || !Types.ObjectId.isValid(outId) || !Types.ObjectId.isValid(inId)) {
      return res.status(400).json({ message: "Invalid id(s) provided" });
    }

    const team = await FantasyTeam.findById(fantasyTeamId).exec();
    if (!team) return res.status(404).json({ message: "Fantasy team not found" });

    // Auth: only owner can substitute
    if (!userId || String(team.user) !== String(userId)) {
      return res.status(403).json({ message: "Forbidden: not team owner" });
    }

    // Ensure both players exist in roster
    const outEntry = team.players.find((p) => String(p.player) === String(outId));
    const inEntry = team.players.find((p) => String(p.player) === String(inId));
    if (!outEntry) return res.status(400).json({ message: "Player to remove (out) not found in this team's roster" });
    if (!inEntry) return res.status(400).json({ message: "Player to add (in) not found in this team's roster" });

    // If swapping between an external player (not on roster) you'd handle differently,
    // but per your schema substitution is between roster entries (starter vs bench).

    // Position categories
    const outPos = normalizePosition(outEntry.position || (outEntry.player && outEntry.player.position));
    const inPos = normalizePosition(inEntry.position || (inEntry.player && inEntry.player.position));

    // GK rule: GK can only be swapped with GK
    if (outPos === "GK" || inPos === "GK") {
      if (!(outPos === "GK" && inPos === "GK")) {
        return res.status(400).json({ message: "Goalkeeper may only be substituted with another goalkeeper." });
      }
    }

    // Perform the swap: swap isStarting flags (so we keep roster order/ids intact)
    // If you want to truly swap player docs (IDs) in roster slots instead, change accordingly.
    const newPlayers = team.players.map((p) => {
      const pid = String(p.player);
      if (pid === String(outId)) return { ...p.toObject(), isStarting: false };
      if (pid === String(inId)) return { ...p.toObject(), isStarting: true };
      return p.toObject ? p.toObject() : p;
    });

    // Validate counts after swap
    const vErr = validateLineupCounts(newPlayers);
    if (vErr) return res.status(400).json({ message: vErr });

    // Save results to DB: update players array and lineup snapshot + lastLineupSetAt
    team.players = newPlayers;
    team.lastLineupSetAt = new Date();

    // create a lineup snapshot under "default" — you can change key to a GW number if desired
    const startingIds = newPlayers.filter((p) => p.isStarting).map((p) => String(p.player));
    const snapshot = {
      starting: startingIds,
      captain: team.captain ? String(team.captain) : null,
      viceCaptain: team.viceCaptain ? String(team.viceCaptain) : null,
      setAt: new Date(),
      isDefault: true,
    };

    // ensure lineupSnapshots is a Map compatible object
    if (!team.lineupSnapshots) team.lineupSnapshots = new Map();
    team.lineupSnapshots.set("default", snapshot);

    await team.save();

    // return updated team (lean on client to re-populate player docs if needed)
    return res.json({ message: "Substitution applied", data: team });
  } catch (err) {
    console.error("substitutePlayers error", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};


/**
 * POST /api/fantasy/set-captain
 * body: { fantasyTeamId, captain?: playerId, viceCaptain?: playerId }
 * Auth: req.user.id must be owner
 */
export const setCaptainVice = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { fantasyTeamId, captain, viceCaptain } = req.body;
    if (!fantasyTeamId) return res.status(400).json({ message: "fantasyTeamId is required" });
    if (!Types.ObjectId.isValid(fantasyTeamId)) return res.status(400).json({ message: "Invalid team id" });

    const team = await FantasyTeam.findById(fantasyTeamId).exec();
    if (!team) return res.status(404).json({ message: "Fantasy team not found" });

    // Auth
    if (!userId || String(team.user) !== String(userId)) {
      return res.status(403).json({ message: "Forbidden: not team owner" });
    }

    // Collect starting players ids
    const startingIds = team.players.filter((p) => p.isStarting).map((p) => String(p.player));

    // If captain provided -> validate is in starting XI
    if (captain) {
      if (!Types.ObjectId.isValid(captain)) return res.status(400).json({ message: "Invalid captain id" });
      if (!startingIds.includes(String(captain))) {
        return res.status(400).json({ message: "Captain must be one of the starting XI." });
      }
      team.captain = captain;
    }

    if (viceCaptain) {
      if (!Types.ObjectId.isValid(viceCaptain)) return res.status(400).json({ message: "Invalid viceCaptain id" });
      if (!startingIds.includes(String(viceCaptain))) {
        return res.status(400).json({ message: "Vice-captain must be one of the starting XI." });
      }
      team.viceCaptain = viceCaptain;
    }

    team.lastLineupSetAt = new Date();

    // also write snapshot
    const snapshot = {
      starting: startingIds,
      captain: team.captain ? String(team.captain) : null,
      viceCaptain: team.viceCaptain ? String(team.viceCaptain) : null,
      setAt: new Date(),
      isDefault: true,
    };
    if (!team.lineupSnapshots) team.lineupSnapshots = new Map();
    team.lineupSnapshots.set("default", snapshot);

    await team.save();

    return res.json({ message: "Captain/vice updated", data: team });
  } catch (err) {
    console.error("setCaptainVice error", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export default {
  createFantasyTeam,
  editFantasyTeam,
  makeTransfers,
  setLineup,
  getAllFantasyTeams,
  getFantasyTeamById,
  computePointsForMatch,
};
