import dotenv from "dotenv";
import mongoose from "mongoose";
import Match from "../models/Match.js";
import Fixture from "../models/Fixtures.js";
import Gameweek from "../models/Gameweek.js";
import Player from "../models/Player.js";
import FantasyTeam from "../models/Felteam.js";
import "../models/Team.js";

dotenv.config();

const POWERUP_KEYS = ["wildcard", "benchBoost", "tripleCaptain"];

function argValue(name) {
  const arg = process.argv.find((item) => item.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : null;
}

function toIdString(value) {
  if (!value) return null;
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizePositionCategory(pos) {
  const q = String(pos || "").toUpperCase();
  if (q === "GK") return "GK";
  if (["CB", "LB", "RB", "LWB", "RWB", "DEF", "DF", "WB"].some((x) => q.includes(x))) return "DEF";
  if (["CM", "DM", "AM", "LM", "RM", "MID", "MF"].some((x) => q.includes(x))) return "MID";
  if (["ST", "CF", "LW", "RW", "FW", "FWD", "ATT"].some((x) => q.includes(x))) return "FWD";
  return "MID";
}

function calculatePlayerMatchPoints(perf = {}, posCategory = "MID", concededGoals = 0, started = false, subOn = false, teamOutcome = null) {
  let pts = 0;
  if (started) pts += 2;
  else if (subOn) pts += 1;

  const goals = asNumber(perf.goals);
  if (goals > 0) {
    if (posCategory === "GK" || posCategory === "DEF") pts += 6 * goals;
    else if (posCategory === "MID") pts += 5 * goals;
    else pts += 4 * goals;
  }

  pts += 3 * asNumber(perf.assists);
  if (perf.manOfTheMatch) pts += 3;
  pts -= asNumber(perf.yellowCards);
  if (perf.redCard) pts -= 3;

  if (started && (posCategory === "GK" || posCategory === "DEF") && asNumber(concededGoals) === 0) pts += 4;
  if (started && posCategory === "MID" && asNumber(concededGoals) === 0) pts += 1;

  if ((started || subOn) && teamOutcome) {
    if (teamOutcome === "win") pts += 3;
    else if (teamOutcome === "draw") pts += 2;
    else if (teamOutcome === "loss") pts += 1;
  }

  return Math.round(pts);
}

function getMapValue(mapLike, key) {
  if (!mapLike) return null;
  if (typeof mapLike.get === "function") return mapLike.get(String(key)) || null;
  return mapLike[String(key)] || null;
}

function mapToObject(mapLike) {
  if (!mapLike) return {};
  if (typeof mapLike.entries === "function") return Object.fromEntries(mapLike.entries());
  return { ...mapLike };
}

function getCurrentSquadIds(teamDoc) {
  return (teamDoc.players || []).map((entry) => toIdString(entry?.player)).filter(Boolean);
}

function getCurrentStartingIds(teamDoc) {
  return (teamDoc.players || [])
    .filter((entry) => !!entry?.isStarting)
    .map((entry) => toIdString(entry?.player))
    .filter(Boolean);
}

function getFantasyTeamGwSnapshot(teamDoc, gameweekNumber) {
  const gwSnapshot = gameweekNumber != null ? getMapValue(teamDoc.lineupSnapshots, String(gameweekNumber)) : null;
  const defaultSnapshot = getMapValue(teamDoc.lineupSnapshots, "default");
  const snapshot = gwSnapshot || defaultSnapshot || {};
  const squad = Array.isArray(snapshot.squad) && snapshot.squad.length
    ? snapshot.squad.map(String)
    : getCurrentSquadIds(teamDoc);
  const starting = Array.isArray(snapshot.starting) && snapshot.starting.length
    ? snapshot.starting.map(String)
    : getCurrentStartingIds(teamDoc);

  return {
    squad,
    starting,
    captain: snapshot.captain ? String(snapshot.captain) : (teamDoc.captain ? String(teamDoc.captain) : null),
    viceCaptain: snapshot.viceCaptain ? String(snapshot.viceCaptain) : (teamDoc.viceCaptain ? String(teamDoc.viceCaptain) : null),
  };
}

function isPowerupActiveForGw(teamDoc, powerupKey, gameweekNumber) {
  return Number(teamDoc.powerups?.[powerupKey]?.usedGameweek) === Number(gameweekNumber);
}

function buildPerfByPlayer(match) {
  const blank = () => ({ goals: 0, assists: 0, yellowCards: 0, redCard: false, manOfTheMatch: false, started: false, subOn: false });
  const perfByPlayer = {};
  const ensure = (id) => {
    const key = String(id);
    perfByPlayer[key] = perfByPlayer[key] || blank();
    return perfByPlayer[key];
  };

  for (const goal of match.goals || []) {
    if (goal.scorer) ensure(goal.scorer).goals += 1;
    if (goal.assist) ensure(goal.assist).assists += 1;
    if (goal.ownBy) ensure(goal.ownBy);
  }
  for (const card of match.cards || []) {
    if (!card.player) continue;
    const perf = ensure(card.player);
    if (String(card.type || "").toLowerCase().includes("yellow")) perf.yellowCards += 1;
    if (String(card.type || "").toLowerCase().includes("red")) perf.redCard = true;
  }
  if (match.manOftheMatch) ensure(match.manOftheMatch).manOfTheMatch = true;
  for (const id of match.lineups?.home || []) ensure(id).started = true;
  for (const id of match.lineups?.away || []) ensure(id).started = true;
  for (const sub of match.substitutions || []) {
    if (sub.playerIn) ensure(sub.playerIn).subOn = true;
    if (sub.playerOut) ensure(sub.playerOut);
  }

  return perfByPlayer;
}

async function getGameweekNumber(match) {
  const fixture = await Fixture.findOne({ match: match._id }).populate("gameweek").lean().exec();
  if (fixture?.gameweek && typeof fixture.gameweek === "object" && fixture.gameweek.number != null) return Number(fixture.gameweek.number);
  if (match.gameweek != null) return Number(match.gameweek);
  const gwDoc = await Gameweek.findOne({ fixtures: match._id }).lean().exec();
  if (gwDoc?.number != null) return Number(gwDoc.number);
  if (match.date) {
    const gwByDate = await Gameweek.findOne({ deadline: { $gt: new Date(match.date) } }).sort({ number: 1 }).lean().exec();
    if (gwByDate?.number != null) return Number(gwByDate.number);
  }
  return null;
}

async function main() {
  const fix = process.argv.includes("--fix");
  const gameweekFilter = argValue("--gameweek");
  const teamFilter = argValue("--team");

  await mongoose.connect(process.env.DB_CONNECTION);

  const matchQuery = { fulltime: true };
  if (gameweekFilter) matchQuery.gameweek = Number(gameweekFilter);
  const matches = await Match.find(matchQuery).populate("homeTeam", "_id").populate("awayTeam", "_id").lean().exec();
  const teams = await FantasyTeam.find(teamFilter ? { _id: teamFilter } : {}).exec();

  const expectedByTeam = new Map();
  const auditedMatchIds = new Set();
  const auditedGameweeks = new Set();

  for (const team of teams) {
    expectedByTeam.set(String(team._id), { matchPoints: {}, gameweekPoints: {} });
  }

  for (const match of matches) {
    const gameweekNumber = await getGameweekNumber(match);
    if (gameweekFilter && Number(gameweekFilter) !== Number(gameweekNumber)) continue;
    if (gameweekNumber == null) continue;

    const matchId = String(match._id);
    auditedMatchIds.add(matchId);
    auditedGameweeks.add(String(gameweekNumber));

    const homeTeamId = toIdString(match.homeTeam);
    const awayTeamId = toIdString(match.awayTeam);
    const homeScore = asNumber(match.homeScore);
    const awayScore = asNumber(match.awayScore);
    const outcomeByTeam = {};
    if (homeTeamId) outcomeByTeam[homeTeamId] = homeScore > awayScore ? "win" : homeScore === awayScore ? "draw" : "loss";
    if (awayTeamId) outcomeByTeam[awayTeamId] = awayScore > homeScore ? "win" : awayScore === homeScore ? "draw" : "loss";

    const perfByPlayer = buildPerfByPlayer(match);
    const playerIds = Object.keys(perfByPlayer);
    const playerDocs = await Player.find({ _id: { $in: playerIds } }).populate("team").lean().exec();
    const playerMap = Object.fromEntries(playerDocs.map((player) => [String(player._id), player]));

    const playerPoints = {};
    for (const pid of playerIds) {
      const player = playerMap[pid];
      if (!player) continue;
      const perf = perfByPlayer[pid] || {};
      const playerTeamId = toIdString(player.team);
      const conceded = playerTeamId === homeTeamId ? awayScore : playerTeamId === awayTeamId ? homeScore : 0;
      playerPoints[pid] = calculatePlayerMatchPoints(
        perf,
        normalizePositionCategory(player.position),
        conceded,
        perf.started,
        perf.subOn,
        playerTeamId ? outcomeByTeam[playerTeamId] : null
      );
    }

    for (const team of teams) {
      if (team.effectiveGameweek && Number(team.effectiveGameweek) > Number(gameweekNumber)) continue;

      const benchBoostActive = isPowerupActiveForGw(team, "benchBoost", gameweekNumber);
      const tripleCaptainActive = isPowerupActiveForGw(team, "tripleCaptain", gameweekNumber);
      const snapshot = getFantasyTeamGwSnapshot(team, gameweekNumber);
      const startingSet = new Set(snapshot.starting.map(String));
      const eligibleSet = new Set((benchBoostActive ? snapshot.squad : snapshot.starting).map(String));

      let total = 0;
      const contributors = [];
      for (const [pid, basePoints] of Object.entries(playerPoints)) {
        if (!eligibleSet.has(pid)) continue;
        const isCaptain = snapshot.captain && String(snapshot.captain) === pid;
        const isVice = snapshot.viceCaptain && String(snapshot.viceCaptain) === pid;
        const countedPoints = isCaptain ? asNumber(basePoints) * (tripleCaptainActive ? 3 : 2) : asNumber(basePoints);
        total += countedPoints;
        contributors.push({
          playerId: pid,
          points: asNumber(basePoints),
          countedPoints,
          isStarting: startingSet.has(pid),
          isCaptain: !!isCaptain,
          isVice: !!isVice,
          benchBoostActive,
          tripleCaptainActive,
        });
      }
      if (!contributors.length) continue;

      const expected = expectedByTeam.get(String(team._id));
      expected.matchPoints[matchId] = { points: total, gameweek: gameweekNumber, contributors };
      expected.gameweekPoints[String(gameweekNumber)] = asNumber(expected.gameweekPoints[String(gameweekNumber)]) + total;
    }
  }

  const issues = [];
  for (const team of teams) {
    const teamId = String(team._id);
    const expected = expectedByTeam.get(teamId);
    const actualMatchPoints = mapToObject(team.matchPoints);
    const actualGameweekPoints = mapToObject(team.gameweekPoints);

    for (const matchId of auditedMatchIds) {
      const actual = actualMatchPoints[matchId]?.points;
      const expectedMatch = expected.matchPoints[matchId]?.points;
      if (asNumber(actual) !== asNumber(expectedMatch)) {
        issues.push({ teamId, type: "match", matchId, actual: asNumber(actual), expected: asNumber(expectedMatch) });
      }
    }

    for (const gw of auditedGameweeks) {
      const actual = actualGameweekPoints[gw];
      const expectedGw = expected.gameweekPoints[gw];
      if (asNumber(actual) !== asNumber(expectedGw)) {
        issues.push({ teamId, type: "gameweek", gameweek: gw, actual: asNumber(actual), expected: asNumber(expectedGw) });
      }
    }

    if (fix) {
      const nextMatchPoints = { ...actualMatchPoints };
      for (const matchId of auditedMatchIds) {
        if (expected.matchPoints[matchId]) nextMatchPoints[matchId] = expected.matchPoints[matchId];
        else delete nextMatchPoints[matchId];
      }

      const nextGameweekPoints = {};
      for (const value of Object.values(nextMatchPoints)) {
        if (value?.gameweek == null) continue;
        const key = String(value.gameweek);
        nextGameweekPoints[key] = asNumber(nextGameweekPoints[key]) + asNumber(value.points);
      }

      team.matchPoints = nextMatchPoints;
      team.gameweekPoints = nextGameweekPoints;
      team.points = Object.values(nextGameweekPoints).reduce((sum, value) => sum + asNumber(value), 0);
      team.markModified("matchPoints");
      team.markModified("gameweekPoints");
      await team.save();
    }
  }

  console.log(JSON.stringify({
    success: true,
    fixed: fix,
    matchesAudited: auditedMatchIds.size,
    teamsAudited: teams.length,
    issueCount: issues.length,
    issues: issues.slice(0, 200),
    truncated: issues.length > 200,
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("[auditFantasyPoints] failed:", error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
