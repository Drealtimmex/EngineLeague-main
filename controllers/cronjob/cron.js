// jobs/playerPriceUpdater.js
import cron from "node-cron";
import Match from "../../models/Match.js";
import Player from "../../models/Player.js";
import mongoose from "mongoose";
import Team from "../../models/Team.js";

/**
 * Price change rules (interpreted & implemented):
 *
 * - Clean sheet (DEF or GK, and player started) => +0.2
 * - Goals:
 *    1 goal => +0.7
 *    2 goals => +1.0
 *    3+ goals => +1.5
 * - Assists:
 *    1 assist => +0.5
 *    2 assists => +0.8
 *    3 assists => +1.0
 *    >3 assists => +2.0
 * - Combined contributions (goals + assists) are additive but we cap total increase per match at +2
 * - Clean sheet + contributions both apply, still respecting the +2 per-match cap
 * - Price limits: min and max come from Player schema (we read them from player.priceMin / max or use constants)
 *
 * You can tweak the numbers below as needed.
 */

const PRICE_CONFIG = {
  minPrice: 7, // fallback if player schema doesn't define min
  maxPrice: 12, // fallback
  cleanSheetIncrease: 0.2,
  goalIncreases: [0, 0.7, 1.0, 1.5], // index = number of goals, 3+ -> 1.5
  assistIncreases: [0, 0.5, 0.8, 1.0], // 3+ -> 1.0 (we map >3 to 2.0 below)
  assistCapAbove3: 2.0,
  perMatchMaxIncrease: 2.0
};

function goalIncreaseForCount(goals) {
  if (goals <= 0) return 0;
  if (goals === 1) return PRICE_CONFIG.goalIncreases[1];
  if (goals === 2) return PRICE_CONFIG.goalIncreases[2];
  return PRICE_CONFIG.goalIncreases[3];
}

function assistIncreaseForCount(assists) {
  if (assists <= 0) return 0;
  if (assists === 1) return PRICE_CONFIG.assistIncreases[1];
  if (assists === 2) return PRICE_CONFIG.assistIncreases[2];
  if (assists === 3) return PRICE_CONFIG.assistIncreases[3];
  return PRICE_CONFIG.assistCapAbove3;
}

// Utility to clamp price
function clampPrice(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// Main cron: every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  try {
    // Find matches that are fulltime and haven't been processed for price updates
    const matches = await Match.find({ fulltime: true, priceUpdatesApplied: { $ne: true } })
      .populate("homeTeam awayTeam")
      .lean()
      .exec();

    if (!matches || matches.length === 0) return;

    console.log(`[playerPriceUpdater] Processing ${matches.length} finished match(es)`);

    for (const match of matches) {
      try {
        // Build per-player stats from match doc:
        // - goals: count of goals where scorer === player
        // - assists: count of goals where assist === player
        // - started: whether in lineups.home or lineups.away
        // - subOn: whether playerIn appears in substitutions
        // - conceded goals for player's team
        const perPlayer = {}; // playerId -> { goals, assists, started, subOn, teamId }

        // Goals & assists
        (match.goals || []).forEach((g) => {
          if (g && g.scorer) {
            const id = g.scorer.toString();
            perPlayer[id] = perPlayer[id] || { goals: 0, assists: 0, started: false, subOn: false, team: null };
            perPlayer[id].goals += 1;
          }
          if (g && g.assist) {
            const id = g.assist.toString();
            perPlayer[id] = perPlayer[id] || { goals: 0, assists: 0, started: false, subOn: false, team: null };
            perPlayer[id].assists += 1;
          }
        });

        // Lineups: started
        (match.lineups?.home || []).forEach((p) => {
          const id = p.toString();
          perPlayer[id] = perPlayer[id] || { goals: 0, assists: 0, started: false, subOn: false, team: null };
          perPlayer[id].started = true;
          perPlayer[id].team = match.homeTeam ? match.homeTeam._id.toString() : perPlayer[id].team;
        });
        (match.lineups?.away || []).forEach((p) => {
          const id = p.toString();
          perPlayer[id] = perPlayer[id] || { goals: 0, assists: 0, started: false, subOn: false, team: null };
          perPlayer[id].started = true;
          perPlayer[id].team = match.awayTeam ? match.awayTeam._id.toString() : perPlayer[id].team;
        });

        // Substitutions: subOn
        (match.substitutions || []).forEach((s) => {
          if (s.playerIn) {
            const id = s.playerIn.toString();
            perPlayer[id] = perPlayer[id] || { goals: 0, assists: 0, started: false, subOn: false, team: null };
            perPlayer[id].subOn = true;
            perPlayer[id].team = s.team ? s.team.toString() : perPlayer[id].team;
          }
        });

        // Cards - not used for price change but you could use it later

        // Determine conceded goals per team
        const homeGoals = (match.goals || []).filter(g => g.team && g.team.toString() === (match.homeTeam?._id?.toString())).length;
        const awayGoals = (match.goals || []).filter(g => g.team && g.team.toString() === (match.awayTeam?._id?.toString())).length;

        // Gather all playerIds we need to update by merging keys with lineups & subs
        const allPlayerIds = new Set([
          ...Object.keys(perPlayer),
          ...(match.lineups?.home || []).map(p => p.toString()),
          ...(match.lineups?.away || []).map(p => p.toString()),
          ...(match.bench?.home || []).map(p => p.toString()),
          ...(match.bench?.away || []).map(p => p.toString()),
          ...(match.substitutions || []).flatMap(s => [s.playerIn && s.playerIn.toString()].filter(Boolean)),
        ]);

        // Load player docs for those players
        const playerIdsArray = Array.from(allPlayerIds).map(id => new mongoose.Types.ObjectId(id));
        const players = await Player.find({ _id: { $in: playerIdsArray } }).populate("team").exec();

        // Build a map for quick writes
        const bulkOps = [];

        for (const pDoc of players) {
          const pid = pDoc._id.toString();
          const stats = perPlayer[pid] || { goals: 0, assists: 0, started: false, subOn: false, team: (pDoc.team?._id?.toString()) || null };

          // Determine contribution counts
          const goals = stats.goals || 0;
          const assists = stats.assists || 0;
          const started = !!stats.started;
          const subOn = !!stats.subOn;

          // Conceded goals applicable if player is DEF or GK
          let concededForPlayer = 0;
          const playerTeamId = (pDoc.team && pDoc.team._id) ? pDoc.team._id.toString() : stats.team;
          if (playerTeamId) {
            if (playerTeamId === (match.homeTeam?._id?.toString())) concededForPlayer = awayGoals;
            else if (playerTeamId === (match.awayTeam?._id?.toString())) concededForPlayer = homeGoals;
          }

          // Compute increases
          let delta = 0;

          // Clean sheet (DEF or GK) => +0.2 if started and concededGoals == 0
          const pos = (pDoc.position || "").toUpperCase();
          if ((pos === "GK" || ["CB","LB","RB"].includes(pos)) && started && concededForPlayer === 0) {
            delta += PRICE_CONFIG.cleanSheetIncrease;
          }

          // Goals and assists contribution
          delta += goalIncreaseForCount(goals);
          delta += assistIncreaseForCount(assists);

          // Cap delta per match
          if (delta > PRICE_CONFIG.perMatchMaxIncrease) delta = PRICE_CONFIG.perMatchMaxIncrease;

          // Apply delta to player's price but respect min/max in schema
          // We'll read min/max from schema defaults or use constants
          const minPrice = (pDoc.schema && pDoc.schema.paths && pDoc.schema.paths.price && pDoc.schema.paths.price.options && pDoc.schema.paths.price.options.min) || PRICE_CONFIG.minPrice;
          const maxPrice = (pDoc.schema && pDoc.schema.paths && pDoc.schema.paths.price && pDoc.schema.paths.price.options && pDoc.schema.paths.price.options.max) || PRICE_CONFIG.maxPrice;

          const newPrice = clampPrice((pDoc.price || PRICE_CONFIG.minPrice) + delta, minPrice, maxPrice);

          if (newPrice !== pDoc.price) {
            bulkOps.push({
              updateOne: {
                filter: { _id: pDoc._id },
                update: { $set: { price: newPrice } }
              }
            });
          }
        } // end players loop

        // Apply bulk updates for player prices
        if (bulkOps.length > 0) {
          await Player.bulkWrite(bulkOps);
          console.log(`[playerPriceUpdater] updated prices for ${bulkOps.length} players for match ${match._id}`);
        } else {
          console.log(`[playerPriceUpdater] no price updates for match ${match._id}`);
        }

        // Mark match as processed
        await Match.updateOne({ _id: match._id }, { $set: { priceUpdatesApplied: true } }).exec();
      } catch (innerErr) {
        console.error(`[playerPriceUpdater] Error processing match ${match._id}:`, innerErr);
        // do not throw, continue with other matches
      }
    } // end for matches
  } catch (err) {
    console.error("[playerPriceUpdater] Cron error:", err);
  }
});
