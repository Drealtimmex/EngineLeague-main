// scripts/replacePlayer.js
/**
 * ES module version.
 *
 * Usage:
 *   node scripts/replacePlayer.js <fromPlayerId> <toPlayerId> [--dry]
 *
 * Make a DB backup before running on production.
 */

import mongoose from "mongoose";
import assert from "assert";
import process from "process";

// Adjust model import paths to match your project structure (extensions required under ESM)
import Player from "../models/Player.js";
import FantasyTeam from "../models/Felteam.js";
import Match from "../models/Match.js";

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error("Usage: node scripts/replacePlayer.js <fromPlayerId> <toPlayerId> [--dry]");
    process.exitCode = 1;
    return;
  }
  const fromId = argv[0];
  const toId = argv[1];
  const dryRun = argv.includes("--dry");

  if (!fromId || !toId) {
    console.error("Both fromPlayerId and toPlayerId are required.");
    process.exitCode = 1;
    return;
  }
  if (fromId === toId) {
    console.error("fromPlayerId and toPlayerId are identical — nothing to do.");
    process.exitCode = 1;
    return;
  }

  const mongoUri = process.env.MONGO_URI || "mongodb+srv://Engine:Engine@cluster0.d6q80qt.mongodb.net/?appName=Cluster0";
  console.log(`Connecting to ${mongoUri} ...`);
  await mongoose.connect(mongoUri);

  const session = await mongoose.startSession();
  const summary = {
    fantasyTeamsUpdated: 0,
    matchesUpdated: 0,
    playersDeleted: 0,
    warnings: [],
  };

  try {
    // Verify players exist
    const [fromPlayer, toPlayer] = await Promise.all([
      Player.findById(fromId).lean().exec(),
      Player.findById(toId).lean().exec(),
    ]);
    if (!fromPlayer) throw new Error(`fromPlayerId not found: ${fromId}`);
    if (!toPlayer) throw new Error(`toPlayerId not found: ${toId}`);

    console.log(`Replacing player ${fromId} -> ${toId} (dryRun=${Boolean(dryRun)})`);

    if (dryRun) {
      await runDryRun(fromId, toId);
      console.log("Dry-run complete. No changes written.");
      await mongoose.disconnect();
      return;
    }

    await session.withTransaction(async () => {
      // ---------- FantasyTeams ----------
      const teamQuery = {
        $or: [
          { "players.player":new  mongoose.Types.ObjectId(fromId) },
          { captain: new mongoose.Types.ObjectId(fromId) },
          { viceCaptain:new mongoose.Types.ObjectId(fromId) },
          { lineupSnapshots: { $exists: true } },
        ],
      };

      const teamsCursor = FantasyTeam.find(teamQuery).session(session).cursor();
      let teamsTouched = 0;
      for (let ft = await teamsCursor.next(); ft != null; ft = await teamsCursor.next()) {
        let changed = false;
        ft.players = Array.isArray(ft.players) ? ft.players : [];

        // Build map by id
        const byId = new Map();
        for (const entry of ft.players) {
          const pid = String(entry.player);
          if (!byId.has(pid)) byId.set(pid, []);
          byId.get(pid).push(entry);
        }

        const entriesFrom = byId.get(String(fromId)) || [];
        const entriesTo = byId.get(String(toId)) || [];

        if (entriesFrom.length > 0 && entriesTo.length === 0) {
          // Replace fromId -> toId in those entries
          for (const e of entriesFrom) {
            e.player = new mongoose.Types.ObjectId(toId);
            changed = true;
          }
        } else if (entriesFrom.length > 0 && entriesTo.length > 0) {
          // Merge duplicates: keep first 'to' entry
          const keep = entriesTo[0];
          for (const removeEntry of entriesFrom) {
            if (removeEntry === keep) continue;

            if (removeEntry.isStarting && !keep.isStarting) keep.isStarting = true;
            if ((!keep.playerPrice || keep.playerPrice === 0) && removeEntry.playerPrice) keep.playerPrice = removeEntry.playerPrice;
            if ((!keep.position || keep.position === "") && removeEntry.position) keep.position = removeEntry.position;
            if ((!keep.team || String(keep.team) === "") && removeEntry.team) keep.team = removeEntry.team;

            const idx = ft.players.indexOf(removeEntry);
            if (idx !== -1) ft.players.splice(idx, 1);
            changed = true;
          }
          keep.player = new mongoose.Types.ObjectId(toId);
        }

        // Update root captain/vice
        if (ft.captain && String(ft.captain) === String(fromId)) {
          ft.captain =new mongoose.Types.ObjectId(toId);
          changed = true;
        }
        if (ft.viceCaptain && String(ft.viceCaptain) === String(fromId)) {
          ft.viceCaptain =new mongoose.Types.ObjectId(toId);
          changed = true;
        }

        // Update lineupSnapshots (Map or plain object)
        if (ft.lineupSnapshots && typeof ft.lineupSnapshots === "object") {
          if (typeof ft.lineupSnapshots.entries === "function") {
            // Map-like
            for (const [k, snap] of ft.lineupSnapshots.entries()) {
              let snapChanged = false;
              if (snap && Array.isArray(snap.starting)) {
                const replaced = snap.starting.map(pid => String(pid) === String(fromId) ? new mongoose.Types.ObjectId(toId) : pid);
                // dedupe
                const deduped = [];
                const seen = new Set();
                for (const v of replaced) {
                  const s = String(v);
                  if (!seen.has(s)) { deduped.push(v); seen.add(s); }
                }
                if (deduped.length !== snap.starting.length) { snap.starting = deduped; snapChanged = true; }
                else if (replaced.some((v,i) => String(v) !== String(snap.starting[i])) ) { snap.starting = replaced; snapChanged = true; }
              }
              if (snap && snap.captain && String(snap.captain) === String(fromId)) { snap.captain =new mongoose.Types.ObjectId(toId); snapChanged = true; }
              if (snap && snap.viceCaptain && String(snap.viceCaptain) === String(fromId)) { snap.viceCaptain = new mongoose.Types.ObjectId(toId); snapChanged = true; }
              if (snapChanged) { ft.lineupSnapshots.set(k, snap); changed = true; }
            }
          } else {
            // Plain object
            const keys = Object.keys(ft.lineupSnapshots || {});
            for (const k of keys) {
              const snap = ft.lineupSnapshots[k];
              if (!snap) continue;
              let snapChanged = false;
              if (Array.isArray(snap.starting)) {
                const replaced = snap.starting.map(pid => String(pid) === String(fromId) ? new mongoose.Types.ObjectId(toId) : pid);
                const deduped = [];
                const seen = new Set();
                for (const v of replaced) {
                  const s = String(v);
                  if (!seen.has(s)) { deduped.push(v); seen.add(s); }
                }
                if (deduped.length !== snap.starting.length) { snap.starting = deduped; snapChanged = true; }
                else if (replaced.some((v,i) => String(v) !== String(snap.starting[i]))) { snap.starting = replaced; snapChanged = true; }
              }
              if (snap.captain && String(snap.captain) === String(fromId)) { snap.captain = new mongoose.Types.ObjectId(toId); snapChanged = true; }
              if (snap.viceCaptain && String(snap.viceCaptain) === String(fromId)) { snap.viceCaptain = new mongoose.Types.ObjectId(toId); snapChanged = true; }
              if (snapChanged) { ft.lineupSnapshots[k] = snap; changed = true; }
            }
          }
        }

        if (changed) {
          await ft.save({ session });
          teamsTouched++;
        }
      } // teams loop

      summary.fantasyTeamsUpdated = teamsTouched;
      console.log(`FantasyTeams updated: ${teamsTouched}`);

      // ---------- Matches ----------
      const matchQuery = {
        $or: [
          { "lineups.home": new mongoose.Types.ObjectId(fromId) },
          { "lineups.away": new mongoose.Types.ObjectId(fromId) },
          { "bench.home":new  mongoose.Types.ObjectId(fromId) },
          { "bench.away":new  mongoose.Types.ObjectId(fromId) },
          { "goals.scorer":new  mongoose.Types.ObjectId(fromId) },
          { "goals.assist":new  mongoose.Types.ObjectId(fromId) },
          { "goals.ownBy":new  mongoose.Types.ObjectId(fromId) },
          { "substitutions.playerIn":new mongoose.Types.ObjectId(fromId) },
          { "substitutions.playerOut":new mongoose.Types.ObjectId(fromId) },
          { "cards.player":new mongoose.Types.ObjectId(fromId) },
          { manOftheMatch: new mongoose.Types.ObjectId(fromId) },
        ],
      };

      const matchesCursor = Match.find(matchQuery).session(session).cursor();
      let matchesTouched = 0;
      for (let mdoc = await matchesCursor.next(); mdoc != null; mdoc = await matchesCursor.next()) {
        let changed = false;
        const m = mdoc;

        const replaceInArray = (arr) => {
          if (!Array.isArray(arr)) return arr;
          const out = arr.map((x) => (String(x) === String(fromId) ? new mongoose.Types.ObjectId(toId) : x));
          const dedup = [];
          const seen = new Set();
          for (const v of out) {
            const s = String(v);
            if (!seen.has(s)) { dedup.push(v); seen.add(s); }
          }
          if (dedup.length !== arr.length || out.some((v,i) => String(v) !== String(arr[i]))) changed = true;
          return dedup;
        };

        if (m.lineups) {
          if (Array.isArray(m.lineups.home)) m.lineups.home = replaceInArray(m.lineups.home);
          if (Array.isArray(m.lineups.away)) m.lineups.away = replaceInArray(m.lineups.away);
        }
        if (m.bench) {
          if (Array.isArray(m.bench.home)) m.bench.home = replaceInArray(m.bench.home);
          if (Array.isArray(m.bench.away)) m.bench.away = replaceInArray(m.bench.away);
        }

        if (Array.isArray(m.goals)) {
          for (const g of m.goals) {
            if (!g) continue;
            if (g.scorer && String(g.scorer) === String(fromId)) { g.scorer = new mongoose.Types.ObjectId(toId); changed = true; }
            if (g.assist && String(g.assist) === String(fromId)) { g.assist = new  mongoose.Types.ObjectId(toId); changed = true; }
            if (g.ownBy && String(g.ownBy) === String(fromId)) { g.ownBy = new  mongoose.Types.ObjectId(toId); changed = true; }
          }
        }

        if (Array.isArray(m.substitutions)) {
          for (const s of m.substitutions) {
            if (!s) continue;
            if (s.playerIn && String(s.playerIn) === String(fromId)) { s.playerIn = new mongoose.Types.ObjectId(toId); changed = true; }
            if (s.playerOut && String(s.playerOut) === String(fromId)) { s.playerOut = new  mongoose.Types.ObjectId(toId); changed = true; }
          }
        }

        if (Array.isArray(m.cards)) {
          for (const c of m.cards) {
            if (!c) continue;
            if (c.player && String(c.player) === String(fromId)) { c.player = new mongoose.Types.ObjectId(toId); changed = true; }
          }
        }

        if (m.manOftheMatch && String(m.manOftheMatch) === String(fromId)) { m.manOftheMatch = new mongoose.Types.ObjectId(toId); changed = true; }

        if (changed) {
          if (typeof m.recomputeScoresFromGoals === "function") {
            try { m.recomputeScoresFromGoals(); } catch (e) { /* non-fatal */ }
          }
          await m.save({ session });
          matchesTouched++;
        }
      } // matches loop

      summary.matchesUpdated = matchesTouched;
      console.log(`Matches updated: ${matchesTouched}`);

      // Optionally delete duplicate player doc (commented out)
      // await Player.deleteOne({ _id: fromId }).session(session).exec();
      // summary.playersDeleted = 1;
    }); // end transaction

    console.log("Migration completed. Summary:", summary);
  } catch (err) {
    console.error("Failed:", err);
    summary.warnings.push(String(err));
  } finally {
    try { await session.endSession(); } catch (e) {}
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
}

/**
 * Dry-run
 */
async function runDryRun(fromId, toId) {
  const teams = await FantasyTeam.find({
    $or: [
      { "players.player":new mongoose.Types.ObjectId(fromId) },
      { captain: new mongoose.Types.ObjectId(fromId) },
      { viceCaptain: new mongoose.Types.ObjectId(fromId) },
      { lineupSnapshots: { $exists: true } },
    ],
  }).lean().exec();

  console.log(`FantasyTeams matched: ${teams.length}`);
  for (const t of teams) {
    let willChange = false;
    const pids = (t.players || []).map((p) => String(p.player));
    if (pids.includes(String(fromId))) willChange = true;
    if (String(t.captain) === String(fromId) || String(t.viceCaptain) === String(fromId)) willChange = true;
    const snaps = t.lineupSnapshots || {};
    const snapKeys = typeof snaps.entries === "function" ? Array.from(snaps.keys()) : Object.keys(snaps || {});
    for (const k of snapKeys) {
      const s = typeof snaps.entries === "function" ? snaps.get(k) : snaps[k];
      if (!s) continue;
      if (Array.isArray(s.starting) && s.starting.map(String).includes(String(fromId))) willChange = true;
      if (String(s.captain) === String(fromId) || String(s.viceCaptain) === String(fromId)) willChange = true;
    }
    if (willChange) {
      console.log(` - Team ${t._id} (${t.teamName || "no-name"}) will be updated`);
    }
  }

  const matches = await Match.find({
    $or: [
      { "lineups.home": new mongoose.Types.ObjectId(fromId) },
      { "lineups.away": new mongoose.Types.ObjectId(fromId) },
      { "bench.home": new mongoose.Types.ObjectId(fromId) },
      { "bench.away": new mongoose.Types.ObjectId(fromId) },
      { "goals.scorer": new mongoose.Types.ObjectId(fromId) },
      { "goals.assist":new  mongoose.Types.ObjectId(fromId) },
      { "goals.ownBy":new  mongoose.Types.ObjectId(fromId) },
      { "substitutions.playerIn": new mongoose.Types.ObjectId(fromId) },
      { "substitutions.playerOut": new  mongoose.Types.ObjectId(fromId) },
      { "cards.player":new  mongoose.Types.ObjectId(fromId) },
      { manOftheMatch:  new mongoose.Types.ObjectId(fromId) },
    ],
  }).lean().exec();

  console.log(`Matches matched: ${matches.length}`);
  for (const m of matches) {
    console.log(` - Match ${m._id} (home: ${m.homeTeam} away: ${m.awayTeam}) will be updated`);
  }

  console.log("Dry-run read complete. No writes performed.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
