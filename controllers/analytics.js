// controllers/analytics.js
import mongoose from "mongoose";
import FantasyTeam from "../models/Felteam.js";
import Player from "../models/Player.js";
import { createError } from "../error.js";

/**
 * GET /api/analytics/most-signed
 * Query params:
 *   - gameweek (number) optional
 *   - position (string) optional (e.g. "CB" or "DEF" or "GK")
 *   - competitionId (string) optional
 *   - limit (number) optional (default 50)
 *
 * Returns: [{ player: { _id, name, position, team }, count, percentage }]
 */
export const getMostSignedPlayers = async (req, res, next) => {
  try {
    const { gameweek, position, competitionId, limit = 50 } = req.query;

    // Parse gameweek if provided
    const gwNumber = gameweek ? parseInt(gameweek, 10) : null;
    const maxLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    // Build base match for FantasyTeam
    const teamMatch = {};
    if (competitionId) teamMatch.competitionId = mongoose.Types.ObjectId(competitionId);

    // If gameweek filter provided, only consider teams that were "active" for that gameweek.
    // Condition: effectiveGameweek <= gwNumber OR gameweekPoints.gwNumber exists
    if (gwNumber) {
      // for map field gameweekPoints we check existence using `gameweekPoints.<gwNumber>`
      const gwKey = `gameweekPoints.${gwNumber}`;
      teamMatch.$or = [
        { effectiveGameweek: { $lte: gwNumber } },
        { [gwKey]: { $exists: true } },
      ];
    }

    // Compute total number of teams considered (denominator for percentage)
    const totalTeamsConsidered = await FantasyTeam.countDocuments(teamMatch).exec();

    // Aggregation pipeline:
    // 1. Match teams according to competitionId and gameweek condition (if any)
    // 2. Unwind players
    // 3. Lookup player details
    // 4. Optional position filter
    // 5. Group by player id to count distinct fantasy teams containing that player (since each team has unique player entry)
    // 6. Sort by count desc
    // 7. Limit
    const pipeline = [];

    // Step 1: match teams
    pipeline.push({ $match: teamMatch });

    // Step 2: unwind players array
    pipeline.push({ $unwind: "$players" });

    // Step 3: group by player id and push unique team id set (not necessary if roster ensures unique player per team,
    // but using $addToSet -> $size ensures dedup safety)
    pipeline.push({
      $group: {
        _id: "$players.player",
        teamsSet: { $addToSet: "$_id" },
        appearances: { $sum: 1 } // fallback count per team (should be 1 per team)
      }
    });

    // Convert teamsSet size to count
    pipeline.push({
      $addFields: {
        count: { $size: "$teamsSet" }
      }
    });

    // Step 4: lookup player doc
    pipeline.push({
      $lookup: {
        from: "players",
        localField: "_id",
        foreignField: "_id",
        as: "playerDoc"
      }
    });

    pipeline.push({ $unwind: "$playerDoc" });

    // Optional position filter
    if (position) {
      const posQuery = position.toUpperCase();
      // accept categories: DEF, MID, FWD, GK OR specific pos like CB, LB, RB, CM, etc.
      if (["DEF", "MID", "FWD", "GK"].includes(posQuery)) {
        // map player's position to category
        pipeline.push({
          $addFields: {
            posCategory: {
              $switch: {
                branches: [
                  { case: { $eq: [{ $toUpper: "$playerDoc.position" }, "GK"] }, then: "GK" },
                  { case: { $in: [{ $toUpper: "$playerDoc.position" }, ["CB", "LB", "RB"]] }, then: "DEF" },
                  { case: { $in: [{ $toUpper: "$playerDoc.position" }, ["CM", "DM", "AM"]] }, then: "MID" },
                  { case: { $in: [{ $toUpper: "$playerDoc.position" }, ["ST", "CF", "LW", "RW"]] }, then: "FWD" }
                ],
                default: "MID"
              }
            }
          }
        });
        pipeline.push({ $match: { posCategory: posQuery } });
      } else {
        // specific position like CB, LB etc.
        pipeline.push({
          $match: { "playerDoc.position": { $regex: new RegExp(`^${posQuery}$`, "i") } }
        });
      }
    }

    // Step 5: project fields we want
    pipeline.push({
      $project: {
        _id: 1,
        count: 1,
        "playerDoc.name": 1,
        "playerDoc.position": 1,
        "playerDoc.team": 1,
        "playerDoc.playerPic": 1,
      }
    });

    // Step 6: sort
    pipeline.push({ $sort: { count: -1 } });

    // Step 7: limit
    pipeline.push({ $limit: maxLimit });

    // Run aggregation
    const agg = await FantasyTeam.aggregate(pipeline).exec();

    // Attach percentage and formatted player
    const result = agg.map((row) => {
      const player = row.playerDoc;
      const count = row.count || 0;
      const percentage = totalTeamsConsidered > 0 ? (count / totalTeamsConsidered) * 100 : 0;
      return {
        player: {
          _id: player._id,
          name: player.name,
          position: player.position,
          team: player.team, // ObjectId; frontend can populate if needed
          playerPic: player.playerPic || null
        },
        count,
        percentage: Math.round(percentage * 100) / 100 // round to 2 decimals
      };
    });

    return res.status(200).json({
      success: true,
      totalTeamsConsidered,
      countReturned: result.length,
      data: result
    });
  } catch (err) {
    console.error("[getMostSignedPlayers] error:", err);
    return next(createError(500, "Error fetching most-signed players"));
  }
};

/**
 * GET /api/analytics/most-points
 * Query params:
 *   - gameweek (number) optional
 *   - position (string) optional (e.g. "CB" or "DEF")
 *   - limit (number) optional (default 50)
 *
 * If gameweek provided -> aggregates fantasyStats for that GW.
 * If not -> sorts by totalFantasyPoints.
 */
export const getTopPlayersByPoints = async (req, res, next) => {
  try {
    const { gameweek, position, limit = 50 } = req.query;
    const gwNumber = gameweek ? parseInt(gameweek, 10) : null;
    const maxLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    // If gameweek filter is provided, aggregate on fantasyStats
    if (gwNumber) {
      const pipeline = [];

      // Unwind fantasyStats
      pipeline.push({ $unwind: "$fantasyStats" });

      // Match gameweek
      pipeline.push({ $match: { "fantasyStats.gameweek": gwNumber } });

      // Optional position filter: handle category DEF/MID/FWD/GK or specific pos
      if (position) {
        const posQuery = position.toUpperCase();
        if (["DEF","MID","FWD","GK"].includes(posQuery)) {
          pipeline.push({
            $addFields: {
              posCategory: {
                $switch: {
                  branches: [
                    { case: { $eq: [{ $toUpper: "$position" }, "GK"] }, then: "GK" },
                    { case: { $in: [{ $toUpper: "$position" }, ["CB","LB","RB"]] }, then: "DEF" },
                    { case: { $in: [{ $toUpper: "$position" }, ["CM","DM","AM"]] }, then: "MID" },
                    { case: { $in: [{ $toUpper: "$position" }, ["ST","CF","LW","RW"]] }, then: "FWD" }
                  ],
                  default: "MID"
                }
              }
            }
          });
          pipeline.push({ $match: { posCategory: posQuery } });
        } else {
          pipeline.push({ $match: { position: posQuery } });
        }
      }

      // Group by player _id and sum points for that gw
      pipeline.push({
        $group: {
          _id: "$_id", // player id
          pointsForGw: { $sum: "$fantasyStats.points" },
          name: { $first: "$name" },
          position: { $first: "$position" },
          team: { $first: "$team" },
          playerPic: { $first: "$playerPic" }
        }
      });

      // Sort and limit
      pipeline.push({ $sort: { pointsForGw: -1 } });
      pipeline.push({ $limit: maxLimit });

      const agg = await Player.aggregate(pipeline).exec();

      return res.status(200).json({
        success: true,
        countReturned: agg.length,
        data: agg.map(p => ({
          player: {
            _id: p._id,
            name: p.name,
            position: p.position,
            team: p.team,
            playerPic: p.playerPic
          },
          points: p.pointsForGw
        }))
      });
    } else {
      // No gameweek filter: use totalFantasyPoints field
      const match = {};
      if (position) {
        const posQuery = position.toUpperCase();
        if (["DEF","MID","FWD","GK"].includes(posQuery)) {
          // translate category into $or predicate for positions
          let posList = [];
          if (posQuery === "DEF") posList = ["CB","LB","RB"];
          if (posQuery === "MID") posList = ["CM","DM","AM","AM"];
          if (posQuery === "FWD") posList = ["ST","CF","LW","RW"];
          if (posQuery === "GK") posList = ["GK"];
          match.position = { $in: posList };
        } else {
          match.position = posQuery;
        }
      }

      const players = await Player.find(match)
        .sort({ totalFantasyPoints: -1 })
        .limit(maxLimit)
        .select("name position team playerPic totalFantasyPoints")
        .lean()
        .exec();

      return res.status(200).json({
        success: true,
        countReturned: players.length,
        data: players.map(p => ({
          player: {
            _id: p._id,
            name: p.name,
            position: p.position,
            team: p.team,
            playerPic: p.playerPic
          },
          points: p.totalFantasyPoints || 0
        }))
      });
    }
  } catch (err) {
    console.error("[getTopPlayersByPoints] error:", err);
    next(createError(500, "Error fetching top players by points"));
  }
};
