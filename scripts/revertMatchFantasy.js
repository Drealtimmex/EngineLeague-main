import dotenv from "dotenv";
import mongoose from "mongoose";
import Match from "../models/Match.js";
import Player from "../models/Player.js";
import FantasyTeam from "../models/Felteam.js";

dotenv.config();

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const matchId = process.argv[2];
  if (!matchId) {
    throw new Error("Usage: node scripts/revertMatchFantasy.js <matchId>");
  }

  await mongoose.connect(process.env.DB_CONNECTION);

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const match = await Match.findById(matchId).session(session).exec();
    if (!match) {
      throw new Error(`Match not found: ${matchId}`);
    }

    const players = await Player.find({ "fantasyStats.match": match._id }).session(session).exec();
    let revertedPlayerCount = 0;

    for (const player of players) {
      const removedEntries = (player.fantasyStats || []).filter((entry) => String(entry.match) === String(match._id));
      if (!removedEntries.length) continue;

      const removedPoints = removedEntries.reduce((sum, entry) => sum + asNumber(entry.points), 0);
      player.fantasyStats = (player.fantasyStats || []).filter((entry) => String(entry.match) !== String(match._id));
      player.totalFantasyPoints = asNumber(player.totalFantasyPoints) - removedPoints;
      if (player.totalFantasyPoints < 0) player.totalFantasyPoints = 0;
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
      }

      await team.save({ session });
      revertedFantasyTeamCount += 1;
    }

    match.fantasyProcessed = false;
    match.fantasyTeamPoints = {};
    await match.save({ session });

    await session.commitTransaction();
    console.log(
      JSON.stringify(
        {
          success: true,
          matchId,
          revertedPlayerCount,
          revertedFantasyTeamCount,
        },
        null,
        2
      )
    );
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error("[revertMatchFantasy] failed:", error);
  process.exit(1);
});
