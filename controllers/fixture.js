// controllers/fixturesController.js (snippet — updated helpers + generateFixturesAuto)
import mongoose from "mongoose";
import Gameweek from "../models/Gameweek.js";
import Fixture from "../models/Fixtures.js";
import Match from "../models/Match.js";
import Team from "../models/Team.js";
import User from "../models/User.js";
import { createError } from "../error.js";

/* -----------------------
   Helpers
   ----------------------- */

const checkAdminRole = async (userId) => {
  const user = await User.findById(userId).lean().exec();
  if (!user || user.role !== "admin") {
    const err = new Error("Unauthorized action. Only admin can perform this.");
    err.status = 403;
    throw err;
  }
};

/**
 * Normalize input id which may be:
 * - string "68f..."
 * - object { teamId: "68f..." } (some clients send this)
 */
const normalizeIdToString = (raw) => {
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    if (raw.teamId) return String(raw.teamId);
    if (raw._id) return String(raw._id);
  }
  return String(raw);
};

const toObjectId = (val) => {
  // accepts string or object with id keys
  const s = normalizeIdToString(val);
  if (!s) throw new Error("Invalid id");
  return new mongoose.Types.ObjectId(s);
};

const validateTeams = async (teamIdsRaw) => {
  // teamIdsRaw can be array of strings or array of objects
  if (!Array.isArray(teamIdsRaw)) throw new Error("teams must be an array");
  const teamIds = teamIdsRaw.map(normalizeIdToString);
  // remove falsy
  const cleaned = teamIds.filter(Boolean);
  if (cleaned.length !== teamIds.length) {
    throw new Error("Some team ids are invalid");
  }
  // Query teams
  const teams = await Team.find({ _id: { $in: cleaned } }).lean().exec();
  if (teams.length !== cleaned.length) {
    const found = teams.map((t) => t._id.toString());
    const missing = cleaned.filter((id) => !found.includes(String(id)));
    throw new Error(`Some teams are invalid or not found: ${missing.join(", ")}`);
  }
  return teams; // array of team docs
};

/**
 * Generate round-robin rounds (circle method).
 * Accepts array of team id strings (already normalized).
 */
function generateRoundRobinRounds(teamIdStrings) {
  const teams = teamIdStrings.map((t) => String(t));
  const n = teams.length;
  const isOdd = n % 2 === 1;
  const arr = teams.slice();

  if (isOdd) arr.push("__BYE__");

  const rounds = [];
  const m = arr.length;
  const roundsCount = m - 1;

  for (let r = 0; r < roundsCount; r++) {
    const pairs = [];
    for (let i = 0; i < m / 2; i++) {
      const a = arr[i];
      const b = arr[m - 1 - i];
      if (a === "__BYE__" || b === "__BYE__") {
        // skip bye pair
        continue;
      }
      pairs.push({ home: a, away: b });
    }
    rounds.push(pairs);
    // rotate (keep first)
    arr.splice(1, 0, arr.pop());
  }

  return rounds;
}

/**
 * Create matches & fixtures for a single round (one gameweek)
 * roundPairs: array of { home: "id", away: "id" } (strings)
 * competitionOid: ObjectId
 */
async function createRoundMatchesAndFixtures(roundPairs = [], competitionOid) {
  const createdFixtureIds = [];

  for (const pair of roundPairs) {
    const homeId = normalizeIdToString(pair.home);
    const awayId = normalizeIdToString(pair.away);
    if (!homeId || !awayId) continue;

    const match = await Match.create({
      homeTeam: new mongoose.Types.ObjectId(homeId),
      awayTeam: new mongoose.Types.ObjectId(awayId),
      date: null,
      venue: null,
      lineups: { home: [], away: [] },
      bench: { home: [], away: [] },
      goals: [],
      substitutions: [],
      cards: [],
      result: null,
      matchRatings: [],
      fulltime: false,
    });

    const fixture = await Fixture.create({
      gameweek: null,
      homeTeam: new mongoose.Types.ObjectId(homeId),
      awayTeam: new mongoose.Types.ObjectId(awayId),
      bye: false,
      match: match._id,
      competitionId: competitionOid,
    });

    createdFixtureIds.push(fixture._id);
  }

  return createdFixtureIds;
}

/* -----------------------
   generateFixturesAuto (improved)
   ----------------------- */

export const generateFixturesAuto = async (req, res, next) => {
  try {
    await checkAdminRole(req.user.id);

    const { teams: teamIdsRaw, competitionId, roundsToGenerate, createPlaceholders = false } = req.body;

    if (!Array.isArray(teamIdsRaw) || teamIdsRaw.length < 2) {
      return next(createError(400, "teams must be an array of at least 2 team IDs"));
    }
    if (!competitionId) return next(createError(400, "competitionId is required"));

    // Normalize competition id and create OID
    let competitionOid;
    try {
      competitionOid = toObjectId(competitionId);
    } catch (err) {
      return next(createError(400, "Invalid competitionId"));
    }

    // Validate teams exist (this will normalize ids internally)
    await validateTeams(teamIdsRaw);

    // normalize team ids to simple strings for scheduling
    const teamIdStrings = teamIdsRaw.map((t) => normalizeIdToString(t)).filter(Boolean);

    // Build round-robin schedule
    const rounds = generateRoundRobinRounds(teamIdStrings);
    const roundsCountAvailable = rounds.length;
    const R = roundsToGenerate ? Math.min(roundsToGenerate, roundsCountAvailable) : Math.min(5, roundsCountAvailable);

    // find next gameweek number for this competition
    // use competitionOid for correctness
    const lastGw = await Gameweek.findOne({ competitionId: competitionOid }).sort({ number: -1 }).lean().exec();
    let nextNumber = lastGw ? lastGw.number + 1 : 1;

    const createdGameweeks = [];

    // Generate R regular-season rounds
    for (let roundIndex = 0; roundIndex < R; roundIndex++) {
      const roundPairs = rounds[roundIndex] || [];

      // create matches & fixtures for this round
      const fixtureIds = await createRoundMatchesAndFixtures(roundPairs, competitionOid);

      // create gameweek document (store competitionId as ObjectId)
      const savedGw = await Gameweek.create({
        number: nextNumber,
        fixtures: fixtureIds,
        competitionId: competitionOid,
        stage: "regular",
      });

      // attach gameweek id to fixtures
      await Fixture.updateMany({ _id: { $in: fixtureIds } }, { $set: { gameweek: savedGw._id } }).exec();

      createdGameweeks.push(savedGw);
      nextNumber += 1;
    }

    // Optionally create placeholders for playoff/semifinal/final (admin fills later)
    const placeholders = [];
    if (createPlaceholders) {
      // Playoff (2 fixtures: 3v6 and 4v5) -> create placeholders
      const playoffFixtureIds = [];
      for (let i = 0; i < 2; i++) {
        const f = await Fixture.create({
          gameweek: null,
          homeTeam: null,
          awayTeam: null,
          bye: false,
          match: null,
          competitionId: competitionOid,
        });
        playoffFixtureIds.push(f._id);
      }
      const playoffGw = await Gameweek.create({
        number: nextNumber,
        fixtures: playoffFixtureIds,
        competitionId: competitionOid,
        stage: "playoff",
      });
      await Fixture.updateMany({ _id: { $in: playoffFixtureIds } }, { $set: { gameweek: playoffGw._id } }).exec();
      placeholders.push({ type: "playoff", gameweek: playoffGw, fixtures: playoffFixtureIds });
      nextNumber += 1;

      // Semifinal placeholders (2 fixtures)
      const semiFixtureIds = [];
      for (let i = 0; i < 2; i++) {
        const f = await Fixture.create({
          gameweek: null,
          homeTeam: null,
          awayTeam: null,
          bye: false,
          match: null,
          competitionId: competitionOid,
        });
        semiFixtureIds.push(f._id);
      }
      const semiGw = await Gameweek.create({
        number: nextNumber,
        fixtures: semiFixtureIds,
        competitionId: competitionOid,
        stage: "semifinal",
      });
      await Fixture.updateMany({ _id: { $in: semiFixtureIds } }, { $set: { gameweek: semiGw._id } }).exec();
      placeholders.push({ type: "semifinal", gameweek: semiGw, fixtures: semiFixtureIds });
      nextNumber += 1;

      // Final placeholder (single fixture)
      const finalFixture = await Fixture.create({
        gameweek: null,
        homeTeam: null,
        awayTeam: null,
        bye: false,
        match: null,
        competitionId: competitionOid,
      });
      const finalGw = await Gameweek.create({
        number: nextNumber,
        fixtures: [finalFixture._id],
        competitionId: competitionOid,
        stage: "final",
      });
      await Fixture.findByIdAndUpdate(finalFixture._id, { $set: { gameweek: finalGw._id } }).exec();
      placeholders.push({ type: "final", gameweek: finalGw, fixtures: [finalFixture._id] });
      nextNumber += 1;
    }

    return res.status(201).json({
      success: true,
      message: `Generated ${createdGameweeks.length} regular gameweeks${createPlaceholders ? " and placeholders" : ""}`,
      gameweeks: createdGameweeks,
      placeholders,
    });
  } catch (err) {
    console.error("[generateFixturesAuto] error:", err);
    return next(err);
  }
};


/**
 * Create fixtures manually (admin)
 * POST /api/fixtures/manual
 * Body: { gameweeks: [ { fixtures:[{ homeTeam, awayTeam, date?, venue? }] }, ... ], competitionId }
 */
export const createFixturesManually = async (req, res, next) => {
  try {
    await checkAdminRole(req.user.id);

    const { gameweeks, competitionId } = req.body;
    if (!Array.isArray(gameweeks) || gameweeks.length === 0)
      return next(createError(400, "gameweeks must be an array with at least one entry"));
    if (!competitionId) return next(createError(400, "competitionId is required"));

    const lastGw = await Gameweek.findOne({ competitionId }).sort({ number: -1 }).lean().exec();
    let nextNumber = lastGw ? lastGw.number + 1 : 1;

    const createdGameweeks = [];

    for (const gw of gameweeks) {
      if (!Array.isArray(gw.fixtures)) return next(createError(400, "each gameweek must include fixtures array"));

      const fixtureIds = [];
      for (const f of gw.fixtures) {
        const { homeTeam, awayTeam, date = null, venue = null } = f;
        if (!homeTeam || !awayTeam) return next(createError(400, "homeTeam and awayTeam are required for each fixture"));

        const match = await Match.create({
          homeTeam: new mongoose.Types.ObjectId(homeTeam),
          awayTeam: new mongoose.Types.ObjectId(awayTeam),
          date,
          venue,
          lineups: { home: [], away: [] },
          bench: { home: [], away: [] },
          goals: [],
          substitutions: [],
          cards: [],
          result: null,
          matchRatings: [],
          fulltime: false,
        });

        const fixture = await Fixture.create({
          gameweek: null,
          homeTeam:new mongoose.Types.ObjectId(homeTeam),
          awayTeam:new  mongoose.Types.ObjectId(awayTeam),
          bye: false,
          match: match._id,
          competitionId,
        });

        fixtureIds.push(fixture._id);
      }

      const savedGw = await Gameweek.create({
        number: nextNumber,
        fixtures: fixtureIds,
        competitionId,
        stage: "regular",
      });

      await Fixture.updateMany({ _id: { $in: fixtureIds } }, { $set: { gameweek: savedGw._id } }).exec();

      createdGameweeks.push(savedGw);
      nextNumber += 1;
    }

    return res.status(201).json({ success: true, message: "Manual gameweeks created", createdGameweeks });
  } catch (err) {
    console.error("[createFixturesManually] error:", err);
    next(err);
  }
};

/**
 * Generate partial fixtures: accept some predefined gameweeks and fill the rest up to roundsToGenerate.
 * POST /api/fixtures/generate-partial
 * Body: { teams: [...], competitionId, predefinedGameweeks: [ { fixtures: [{ homeTeam, awayTeam }] }, ... ], roundsToGenerate?: Number }
 */
export const generatePartialFixtures = async (req, res, next) => {
  try {
    await checkAdminRole(req.user.id);

    const { teams: teamIds, competitionId, predefinedGameweeks = [], roundsToGenerate } = req.body;

    if (!Array.isArray(teamIds) || teamIds.length < 2)
      return next(createError(400, "teams must be an array with at least 2 team ids"));
    if (!competitionId) return next(createError(400, "competitionId is required"));

    await validateTeams(teamIds);

    const allRounds = generateRoundRobinRounds(teamIds);
    const roundsAvailable = allRounds.length;
    const R = roundsToGenerate ? Math.min(roundsToGenerate, roundsAvailable) : Math.min(5, roundsAvailable);

    const alreadyProvided = Array.isArray(predefinedGameweeks) ? predefinedGameweeks.length : 0;
    if (alreadyProvided > R) return next(createError(400, "You provided more predefined gameweeks than requested total rounds"));

    const lastGw = await Gameweek.findOne({ competitionId }).sort({ number: -1 }).lean().exec();
    let nextNumber = lastGw ? lastGw.number + 1 : 1;
    const createdGameweeks = [];

    // Persist predefined gameweeks first (manual ones provided)
    for (const gw of predefinedGameweeks) {
      if (!Array.isArray(gw.fixtures)) return next(createError(400, "Each predefined gameweek must include fixtures array"));
      const fixtureIds = [];
      for (const f of gw.fixtures) {
        const { homeTeam, awayTeam, date = null, venue = null } = f;
        if (!homeTeam || !awayTeam) return next(createError(400, "homeTeam and awayTeam are required in predefined fixtures"));

        const match = await Match.create({
          homeTeam: mongoose.Types.ObjectId(homeTeam),
          awayTeam: mongoose.Types.ObjectId(awayTeam),
          date,
          venue,
          lineups: { home: [], away: [] },
          bench: { home: [], away: [] },
          goals: [],
          substitutions: [],
          cards: [],
          result: null,
          matchRatings: [],
          fulltime: false,
        });

        const fixture = await Fixture.create({
          gameweek: null,
          homeTeam: mongoose.Types.ObjectId(homeTeam),
          awayTeam: mongoose.Types.ObjectId(awayTeam),
          bye: false,
          match: match._id,
          competitionId,
        });

        fixtureIds.push(fixture._id);
      }

      const savedGw = await Gameweek.create({
        number: nextNumber,
        fixtures: fixtureIds,
        competitionId,
        stage: "regular",
      });

      await Fixture.updateMany({ _id: { $in: fixtureIds } }, { $set: { gameweek: savedGw._id } }).exec();

      createdGameweeks.push(savedGw);
      nextNumber += 1;
    }

    // Generate remaining rounds from round-robin schedule
    const startRoundIdx = alreadyProvided;
    const roundsToCreate = Math.max(0, R - alreadyProvided);

    for (let i = 0; i < roundsToCreate; i++) {
      const roundPairs = allRounds[startRoundIdx + i];
      if (!roundPairs) continue;
      const fixtureIds = await createRoundMatchesAndFixtures(roundPairs, competitionId);

      const savedGw = await Gameweek.create({
        number: nextNumber,
        fixtures: fixtureIds,
        competitionId,
        stage: "regular",
      });

      await Fixture.updateMany({ _id: { $in: fixtureIds } }, { $set: { gameweek: savedGw._id } }).exec();

      createdGameweeks.push(savedGw);
      nextNumber += 1;
    }

    return res.status(201).json({
      success: true,
      message: `Partial generation complete. Created ${createdGameweeks.length} gameweeks.`,
      gameweeks: createdGameweeks,
    });
  } catch (err) {
    console.error("[generatePartialFixtures] error:", err);
    next(err);
  }
};

/**
 * Create knockout placeholders (semifinals/final/playoffs).
 * Admin will later fill these placeholders with actual matchups once teams are known.
 *
 * POST /api/fixtures/knockout/placeholders
 * Body: { competitionId, stage: 'semifinal'|'final'|'playoff', slots: number, numberOfLegs?: number }
 */
export const createKnockoutPlaceholders = async (req, res, next) => {
  try {
    await checkAdminRole(req.user.id);

    const { competitionId, stage = "semifinal", slots = 2, numberOfLegs = 1 } = req.body;
    if (!competitionId) return next(createError(400, "competitionId is required"));

    const lastGw = await Gameweek.findOne({ competitionId }).sort({ number: -1 }).lean().exec();
    let nextNumber = lastGw ? lastGw.number + 1 : 1;

    const created = [];

    // Create one gameweek per leg (if multiple legs requested)
    for (let leg = 1; leg <= numberOfLegs; leg++) {
      const fixtureIds = [];
      for (let s = 0; s < slots; s++) {
        const f = await Fixture.create({
          gameweek: null,
          homeTeam: null,
          awayTeam: null,
          bye: false,
          match: null,
          competitionId,
        });
        fixtureIds.push(f._id);
      }

      const gw = await Gameweek.create({
        number: nextNumber,
        fixtures: fixtureIds,
        competitionId,
        stage,
      });

      await Fixture.updateMany({ _id: { $in: fixtureIds } }, { $set: { gameweek: gw._id } }).exec();

      created.push({ gameweek: gw, leg, fixtures: fixtureIds });
      nextNumber += 1;
    }

    return res.status(201).json({ success: true, message: "Knockout placeholders created", created });
  } catch (err) {
    console.error("[createKnockoutPlaceholders] error:", err);
    next(err);
  }
};

/**
 * Fill knockout fixtures (set teams and create underlying Match docs)
 * POST /api/fixtures/knockout/fill
 * Body: { gameweekId, pairings: [ { fixtureId, homeTeam, awayTeam, date?, venue? } ] }
 */
export const fillKnockoutFixtures = async (req, res, next) => {
  try {
    await checkAdminRole(req.user.id);

    const { gameweekId, pairings } = req.body;
    if (!gameweekId) return next(createError(400, "gameweekId is required"));
    if (!Array.isArray(pairings) || pairings.length === 0) return next(createError(400, "pairings required"));

    const updates = [];

    for (const p of pairings) {
      const { fixtureId, homeTeam, awayTeam, date = null, venue = null } = p;
      if (!fixtureId || !homeTeam || !awayTeam) {
        return next(createError(400, "fixtureId, homeTeam and awayTeam are required for each pairing"));
      }

      const match = await Match.create({
        homeTeam: mongoose.Types.ObjectId(homeTeam),
        awayTeam: mongoose.Types.ObjectId(awayTeam),
        date,
        venue,
        lineups: { home: [], away: [] },
        bench: { home: [], away: [] },
        goals: [],
        substitutions: [],
        cards: [],
        result: null,
        matchRatings: [],
        fulltime: false,
      });

      const updated = await Fixture.findByIdAndUpdate(
        fixtureId,
        {
          $set: {
            match: match._id,
            homeTeam: mongoose.Types.ObjectId(homeTeam),
            awayTeam: mongoose.Types.ObjectId(awayTeam),
            bye: false,
          },
        },
        { new: true }
      ).exec();

      updates.push({ fixture: updated, matchId: match._id });
    }

    return res.status(200).json({ success: true, message: "Knockout fixtures filled", updates });
  } catch (err) {
    console.error("[fillKnockoutFixtures] error:", err);
    next(err);
  }
};

/**
 * Optional convenience endpoint: list placeholder fixtures for a competition grouped by stage.
 * GET /api/fixtures/placeholders/:competitionId
 */
export const getPlaceholdersByCompetition = async (req, res, next) => {
  try {
    const { competitionId } = req.params;
    if (!competitionId) return next(createError(400, "competitionId is required"));

    // find fixtures where match is null (placeholders)
    const fixtures = await Fixture.find({ competitionId, match: null }).populate("gameweek").lean().exec();

    const grouped = fixtures.reduce((acc, f) => {
      const stage = (f.gameweek && f.gameweek.stage) || "unknown";
      acc[stage] = acc[stage] || [];
      acc[stage].push(f);
      return acc;
    }, {});

    return res.status(200).json({ success: true, data: grouped });
  } catch (err) {
    console.error("[getPlaceholdersByCompetition] error:", err);
    next(err);
  }
};
