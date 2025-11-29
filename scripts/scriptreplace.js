/**
 * scripts/replace-player.js
 *
 * Replace duplicate player id (fromId) with canonical player id (toId):
 * - Updates FantasyTeam.players entries (merge duplicates when both exist)
 * - Updates FantasyTeam.lineupSnapshots (starting[], captain, viceCaptain)
 * - Updates FantasyTeam.captain / viceCaptain at team root
 * - Updates Match docs: lineups, bench, goals.scorer/assist/ownBy, substitutions, cards, manOftheMatch
 *
 * Usage:
 *   node scripts/replace-player.js <fromPlayerId> <toPlayerId> [--dry]
 *
 * Notes:
 *  - Adjust model import paths if your project structure differs.
 *  - Make a DB backup before running on production.
 */

const mongoose = require("mongoose");
const assert = require("assert");

// Adjust these requires to your project structure:
const Player = require("../models/Player").default || require("../models/Player");
const FantasyTeam = require("../models/Felteam").default || require("../models/Felteam");
const Match = require("../models/Match").default || require("../models/Match");

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error("Usage: node replace-player.js <fromPlayerId> <toPlayerId> [--dry]");
    process.exit(1);
  }
  const fromId = argv[0];
  const toId = argv[1];
  const dryRun = argv.includes("--dry");

  if (!fromId || !toId) {
    console.error("Both fromPlayerId and toPlayerId are required.");
    process.exit(1);
  }
  if (fromId === toId) {
    console.error("fromPlayerId and toPlayerId are identical — nothing to do.");
    process.exit(1);
  }

  const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/yourdb";
  console.log(`Connecting to ${mongoUri} ...`);
  await mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });

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

    // We'll run critical updates inside a transaction if not dry run
    if (dryRun) {
      // Dry-run: we will just simulate by reading and printing planned changes (no writes)
      await runDryRun(fromId, toId);
      console.log("Dry-run complete. No changes written.");
      await mongoose.disconnect();
      process.exit(0);
    }

    // Real run: use transaction
    await session.withTransaction(async () => {
      // 1) Update FantasyTeams
      // Find teams referencing fromId either in players array or lineupSnapshots or root captain/viceCaptain
      const teamQuery = {
        $or: [
          { "players.player": mongoose.Types.ObjectId(fromId) },
          { captain: mongoose.Types.ObjectId(fromId) },
          { viceCaptain: mongoose.Types.ObjectId(fromId) },
          { lineupSnapshots: { $exists: true } }, // we'll inspect snapshots for occurrences
        ],
      };

      const teamsCursor = FantasyTeam.find(teamQuery).session(session).cursor();
      let teamsTouched = 0;
      for (let ft = await teamsCursor.next(); ft != null; ft = await teamsCursor.next()) {
        let changed = false;
        // ensure ft.players exists
        ft.players = Array.isArray(ft.players) ? ft.players : [];

        // Build map of entries by player id (string)
        const byId = new Map();
        for (const entry of ft.players) {
          const pid = String(entry.player);
          if (!byId.has(pid)) byId.set(pid, []);
          byId.get(pid).push(entry);
        }

        const entriesFrom = byId.get(String(fromId)) || [];
        const entriesTo = byId.get(String(toId)) || [];

        if (entriesFrom.length > 0 && entriesTo.length === 0) {
          // No canonical entry present: simply replace player id on those entries
          for (const e of entriesFrom) {
            e.player = mongoose.Types.ObjectId(toId);
            changed = true;
          }
        } else if (entriesFrom.length > 0 && entriesTo.length > 0) {
          // Both present: merge duplicates into the canonical (keep first to-entry)
          const keep = entriesTo[0];
          for (const removeEntry of entriesFrom) {
            // If removeEntry is exactly the same object as keep, skip
            if (String(removeEntry.player) === String(keep.player) && removeEntry === keep) continue;

            // Merge isStarting: if any true -> keep.isStarting = true
            if (removeEntry.isStarting) {
              if (!keep.isStarting) {
                keep.isStarting = true;
              }
            }
            // Merge playerPrice if keep has no valid price
            if ((!keep.playerPrice || keep.playerPrice === 0) && removeEntry.playerPrice) {
              keep.playerPrice = removeEntry.playerPrice;
            }
            // Merge position / team fields
            if ((!keep.position || keep.position === "") && removeEntry.position) keep.position = removeEntry.position;
            if ((!keep.team || String(keep.team) === "") && removeEntry.team) keep.team = removeEntry.team;

            // Remove duplicate entry from ft.players array
            const idx = ft.players.indexOf(removeEntry);
            if (idx !== -1) {
              ft.players.splice(idx, 1);
            }
            changed = true;
          }
          // ensure keep.player is canonical ObjectId
          keep.player = mongoose.Types.ObjectId(toId);
        }

        // If entriesFrom empty but lineupSnapshots/captain/vice contains fromId, still update snapshots below

        // Update root captain/vice
        if (ft.captain && String(ft.captain) === String(fromId)) {
          ft.captain = mongoose.Types.ObjectId(toId);
          changed = true;
        }
        if (ft.viceCaptain && String(ft.viceCaptain) === String(fromId)) {
          ft.viceCaptain = mongoose.Types.ObjectId(toId);
          changed = true;
        }

        // Update lineupSnapshots map (Map<string, lineupSnapshot>)
        if (ft.lineupSnapshots && typeof ft.lineupSnapshots === "object") {
          // lineupSnapshots may be a Map (has entries) or a plain object
          if (typeof ft.lineupSnapshots.entries === "function") {
            // Map-like
            const toSet = [];
            for (const [k, snap] of ft.lineupSnapshots.entries()) {
              let snapChanged = false;
              if (snap && Array.isArray(snap.starting)) {
                let replaced = false;
                const newStarting = snap.starting.map((pid) => {
                  if (String(pid) === String(fromId)) {
                    replaced = true;
                    return mongoose.Types.ObjectId(toId);
                  }
                  return pid;
                });
                // dedupe starting array (if canonical appears twice after replacement)
                const deduped = [];
                const seen = new Set();
                for (const v of newStarting) {
                  const s = String(v);
                  if (!seen.has(s)) {
                    deduped.push(v);
                    seen.add(s);
                  }
                }
                if (deduped.length !== snap.starting.length || replaced) {
                  snap.starting = deduped;
                  snapChanged = true;
                }
              }
              if (snap && snap.captain && String(snap.captain) === String(fromId)) {
                snap.captain = mongoose.Types.ObjectId(toId);
                snapChanged = true;
              }
              if (snap && snap.viceCaptain && String(snap.viceCaptain) === String(fromId)) {
                snap.viceCaptain = mongoose.Types.ObjectId(toId);
                snapChanged = true;
              }
              if (snapChanged) {
                ft.lineupSnapshots.set(k, snap);
                changed = true;
              }
            }
          } else {
            // Plain object
            const keys = Object.keys(ft.lineupSnapshots || {});
            for (const k of keys) {
              const snap = ft.lineupSnapshots[k];
              if (!snap) continue;
              let snapChanged = false;
              if (Array.isArray(snap.starting)) {
                let replaced = false;
                const newStarting = snap.starting.map((pid) => {
                  if (String(pid) === String(fromId)) {
                    replaced = true;
                    return mongoose.Types.ObjectId(toId);
                  }
                  return pid;
                });
                // dedupe
                const deduped = [];
                const seen = new Set();
                for (const v of newStarting) {
                  const s = String(v);
                  if (!seen.has(s)) {
                    deduped.push(v);
                    seen.add(s);
                  }
                }
                if (deduped.length !== snap.starting.length || replaced) {
                  snap.starting = deduped;
                  snapChanged = true;
                }
              }
              if (snap.captain && String(snap.captain) === String(fromId)) {
                snap.captain = mongoose.Types.ObjectId(toId);
                snapChanged = true;
              }
              if (snap.viceCaptain && String(snap.viceCaptain) === String(fromId)) {
                snap.viceCaptain = mongoose.Types.ObjectId(toId);
                snapChanged = true;
              }
              if (snapChanged) {
                ft.lineupSnapshots[k] = snap;
                changed = true;
              }
            }
          }
        }

        // After changes, ensure ft.players length remains valid (<= 15). If merging reduced length below expected,
        // we just proceed; you may want to re-add a placeholder if your app requires fixed length.
        // Save ft if changed
        if (changed) {
          await ft.save({ session });
          teamsTouched++;
        }
      } // end teams loop

      summary.fantasyTeamsUpdated = teamsTouched;
      console.log(`FantasyTeams updated: ${teamsTouched}`);

      // 2) Update Matches
      // Find matches where fromId referenced in relevant fields
      const matchQuery = {
        $or: [
          { "lineups.home": mongoose.Types.ObjectId(fromId) },
          { "lineups.away": mongoose.Types.ObjectId(fromId) },
          { "bench.home": mongoose.Types.ObjectId(fromId) },
          { "bench.away": mongoose.Types.ObjectId(fromId) },
          { "goals.scorer": mongoose.Types.ObjectId(fromId) },
          { "goals.assist": mongoose.Types.ObjectId(fromId) },
          { "goals.ownBy": mongoose.Types.ObjectId(fromId) },
          { "substitutions.playerIn": mongoose.Types.ObjectId(fromId) },
          { "substitutions.playerOut": mongoose.Types.ObjectId(fromId) },
          { "cards.player": mongoose.Types.ObjectId(fromId) },
          { manOftheMatch: mongoose.Types.ObjectId(fromId) },
        ],
      };

      const matchesCursor = Match.find(matchQuery).session(session).cursor();
      let matchesTouched = 0;
      for (let mdoc = await matchesCursor.next(); mdoc != null; mdoc = await matchesCursor.next()) {
        let changed = false;
        const m = mdoc;

        // Helper to replace ids in arrays (home/away lineups/bench)
        const replaceInArray = (arr) => {
          if (!Array.isArray(arr)) return arr;
          const out = arr.map((x) => (String(x) === String(fromId) ? mongoose.Types.ObjectId(toId) : x));
          // dedupe
          const dedup = [];
          const seen = new Set();
          for (const v of out) {
            const s = String(v);
            if (!seen.has(s)) {
              dedup.push(v);
              seen.add(s);
            }
          }
          if (JSON.stringify(dedup) !== JSON.stringify(arr)) changed = true;
          return dedup;
        };

        if (m.lineups) {
          if (Array.isArray(m.lineups.home)) {
            const newHome = replaceInArray(m.lineups.home);
            if (newHome !== m.lineups.home) m.lineups.home = newHome;
          }
          if (Array.isArray(m.lineups.away)) {
            const newAway = replaceInArray(m.lineups.away);
            if (newAway !== m.lineups.away) m.lineups.away = newAway;
          }
        }
        if (m.bench) {
          if (Array.isArray(m.bench.home)) {
            const newBenchHome = replaceInArray(m.bench.home);
            if (newBenchHome !== m.bench.home) m.bench.home = newBenchHome;
          }
          if (Array.isArray(m.bench.away)) {
            const newBenchAway = replaceInArray(m.bench.away);
            if (newBenchAway !== m.bench.away) m.bench.away = newBenchAway;
          }
        }

        // Goals (scorer / assist / ownBy)
        if (Array.isArray(m.goals)) {
          for (const g of m.goals) {
            if (!g) continue;
            if (g.scorer && String(g.scorer) === String(fromId)) {
              g.scorer = mongoose.Types.ObjectId(toId);
              changed = true;
            }
            if (g.assist && String(g.assist) === String(fromId)) {
              g.assist = mongoose.Types.ObjectId(toId);
              changed = true;
            }
            if (g.ownBy && String(g.ownBy) === String(fromId)) {
              g.ownBy = mongoose.Types.ObjectId(toId);
              changed = true;
            }
          }
        }

        // substitutions
        if (Array.isArray(m.substitutions)) {
          for (const s of m.substitutions) {
            if (!s) continue;
            if (s.playerIn && String(s.playerIn) === String(fromId)) {
              s.playerIn = mongoose.Types.ObjectId(toId);
              changed = true;
            }
            if (s.playerOut && String(s.playerOut) === String(fromId)) {
              s.playerOut = mongoose.Types.ObjectId(toId);
              changed = true;
            }
          }
        }

        // cards
        if (Array.isArray(m.cards)) {
          for (const c of m.cards) {
            if (!c) continue;
            if (c.player && String(c.player) === String(fromId)) {
              c.player = mongoose.Types.ObjectId(toId);
              changed = true;
            }
          }
        }

        // manOftheMatch
        if (m.manOftheMatch && String(m.manOftheMatch) === String(fromId)) {
          m.manOftheMatch = mongoose.Types.ObjectId(toId);
          changed = true;
        }

        if (changed) {
          // recompute scores or other derived fields if you rely on pre-save hooks
          if (typeof m.recomputeScoresFromGoals === "function") {
            try {
              m.recomputeScoresFromGoals();
            } catch (e) {
              // non-fatal
            }
          }
          await m.save({ session });
          matchesTouched++;
        }
      } // end matches loop

      summary.matchesUpdated = matchesTouched;
      console.log(`Matches updated: ${matchesTouched}`);

      // 3) Optionally remove duplicate Player doc
      // We do not delete automatically — keep commented out unless you're sure
      // await Player.deleteOne({ _id: fromId }).session(session).exec();
      // summary.playersDeleted = 1;
      // console.log("Deleted duplicate Player doc:", fromId);

    }); // end transaction

    console.log("Migration completed. Summary:", summary);
  } catch (err) {
    console.error("Failed:", err);
    summary.warnings.push(String(err));
  } finally {
    try {
      await session.endSession();
    } catch (e) {}
    await mongoose.disconnect();
    console.log("Disconnected.");
    process.exit(0);
  }
}

/**
 * Dry-run: read affected docs and print summary of what would change.
 */
async function runDryRun(fromId, toId) {
  // Print count of fantasy teams with fromId in roster or snapshots
  const teams = await FantasyTeam.find({
    $or: [
      { "players.player": mongoose.Types.ObjectId(fromId) },
      { captain: mongoose.Types.ObjectId(fromId) },
      { viceCaptain: mongoose.Types.ObjectId(fromId) },
      { lineupSnapshots: { $exists: true } },
    ],
  }).lean().exec();

  console.log(`FantasyTeams matched: ${teams.length}`);
  for (const t of teams) {
    let willChange = false;
    // check players array
    const pids = (t.players || []).map((p) => String(p.player));
    if (pids.includes(String(fromId))) willChange = true;
    if (String(t.captain) === String(fromId) || String(t.viceCaptain) === String(fromId)) willChange = true;
    // check snapshots
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

  // Matches
  const matches = await Match.find({
    $or: [
      { "lineups.home": mongoose.Types.ObjectId(fromId) },
      { "lineups.away": mongoose.Types.ObjectId(fromId) },
      { "bench.home": mongoose.Types.ObjectId(fromId) },
      { "bench.away": mongoose.Types.ObjectId(fromId) },
      { "goals.scorer": mongoose.Types.ObjectId(fromId) },
      { "goals.assist": mongoose.Types.ObjectId(fromId) },
      { "goals.ownBy": mongoose.Types.ObjectId(fromId) },
      { "substitutions.playerIn": mongoose.Types.ObjectId(fromId) },
      { "substitutions.playerOut": mongoose.Types.ObjectId(fromId) },
      { "cards.player": mongoose.Types.ObjectId(fromId) },
      { manOftheMatch: mongoose.Types.ObjectId(fromId) },
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
