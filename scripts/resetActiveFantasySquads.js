import dotenv from "dotenv";
import mongoose from "mongoose";
import Competition from "../models/Competition.js";
import FantasyTeam from "../models/Felteam.js";

dotenv.config();

async function main() {
  await mongoose.connect(process.env.DB_CONNECTION);
  try {
    const activeCompetitions = await Competition.find({ isActive: true }).sort({ createdAt: -1 }).lean();
    if (activeCompetitions.length !== 1) {
      throw new Error(`Expected exactly one active competition; found ${activeCompetitions.length}. No squads were changed.`);
    }

    const competition = activeCompetitions[0];
    const teams = await FantasyTeam.find({ competitionId: competition._id })
      .select("players points gameweekPoints matchPoints lineupSnapshots")
      .lean();
    const selectedRosters = teams.filter((team) => (team.players || []).length > 0).length;
    const savedHistory = teams.filter((team) => {
      const hasValues = (value) => value && (typeof value.size === "number" ? value.size > 0 : Object.keys(value).length > 0);
      return Number(team.points || 0) !== 0 || hasValues(team.gameweekPoints) || hasValues(team.matchPoints) || hasValues(team.lineupSnapshots);
    }).length;

    console.log(JSON.stringify({
      competition: competition.name,
      season: competition.season,
      competitionId: String(competition._id),
      fantasyTeams: teams.length,
      rostersToClear: selectedRosters,
      teamsWithSavedPointsOrSnapshots: savedHistory,
      mode: process.argv.includes("--apply") ? "apply" : "dry-run",
    }, null, 2));

    if (process.argv.includes("--apply")) {
      const result = await FantasyTeam.updateMany(
        { competitionId: competition._id },
        { $set: { players: [], captain: null, viceCaptain: null } }
      );
      console.log(JSON.stringify({ matched: result.matchedCount, modified: result.modifiedCount }));
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
