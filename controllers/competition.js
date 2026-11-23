import Competition from "../models/Competition.js"
import Team from "../models/Team.js"
import Player from "../models/Player.js"
import User from "../models/User.js"
import FantasyTeam from "../models/Felteam.js"
import { createError } from "../error.js";

// Create Team
export const createCompetition = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);

    // Verify if the user is an admin
    if (!user || user.role !== "admin") {
      return next(createError(403, "Only admins can create teams"));
    }

    const { name, logo, season } = req.body;

    // Create a new team
    // Creating a new season makes it current; prior competition documents and
    // all of their matches/statistics remain intact.
    const previous = await Competition.findOne({ isActive: true }).sort({ createdAt: -1 })
      || await Competition.findOne().sort({ createdAt: -1 });
    const previousTeams = previous ? await Team.find({ competitionId: previous._id }) : [];
    const newCompetition = await Competition.create({
      name, logo, season: season || name, isActive: true,
      teams: previousTeams.map((team) => team._id),
    });
    // Carry manager identities into the new season, but require a fresh squad.
    // The previous competition's fantasy teams and snapshots are left untouched.
    if (previous) {
      const previousFantasyTeams = await FantasyTeam.find({ competitionId: previous._id }).lean();
      for (const oldFantasy of previousFantasyTeams) {
        await FantasyTeam.create({
          user: oldFantasy.user,
          teamName: oldFantasy.teamName,
          teamLogo: oldFantasy.teamLogo,
          players: [],
          budget: 150,
          points: 0,
          competitionId: newCompetition._id,
          captain: null,
          viceCaptain: null,
          effectiveGameweek: 1,
          // Full squad selection is the GW1 action; transfers remain capped at 3.
          transfers: { lastResetGw: 1, freeTransfersUsedInGw: 3, openingTransfersRemaining: 0, openingTransferWindow: false },
          powerups: { wildcard: { available: true }, benchBoost: { available: true }, tripleCaptain: { available: true } },
          gameweekPoints: {},
          matchPoints: {},
          lineupSnapshots: { default: { squad: [], starting: [], captain: null, viceCaptain: null, isDefault: true, setAt: new Date() } },
          lastLineupSetAt: null,
          createdAt: new Date(),
        });
      }
    }
    for (const team of previousTeams) {
      const oldId = String(previous._id);
      const snapshots = team.seasonSnapshots || new Map();
      const value = {
        competitionId: previous._id,
        matchesPlayed: team.matchesPlayed, wins: team.wins, draws: team.draws,
        losses: team.losses, goalsFor: team.goalsFor, goalsAgainst: team.goalsAgainst,
        points: team.points,
      };
      if (typeof snapshots.set === "function") snapshots.set(oldId, value);
      else snapshots[oldId] = value;
      team.seasonSnapshots = snapshots;
      team.competitionId = newCompetition._id;
      team.matchesPlayed = team.wins = team.draws = team.losses = 0;
      team.goalsFor = team.goalsAgainst = team.points = 0;
      team.markModified("seasonSnapshots");
      await team.save();
    }
    if (previous) {
      const players = await Player.find({});
      for (const player of players) {
        const oldId = String(previous._id);
        const snapshots = player.seasonSnapshots || new Map();
        const value = {
          competitionId: previous._id,
          goals: player.goals, assists: player.assists,
          yellowCards: player.totalyellowCards, redCards: player.totalredCards,
        };
        if (typeof snapshots.set === "function") snapshots.set(oldId, value);
        else snapshots[oldId] = value;
        player.seasonSnapshots = snapshots;
        player.goals = player.assists = player.totalyellowCards = player.totalredCards = 0;
        player.markModified("seasonSnapshots");
        await player.save();
      }
    }
    if (previous) await Competition.updateOne({ _id: previous._id }, { $set: { isActive: false } });

    res.status(201).json({
      success: true,
      data: newCompetition,
    });
  } catch (error) {
    console.error("Error creating team:", error);
    next(createError(500, "Failed to create team"));
  }
};

export const getActiveCompetition = async (_req, res, next) => {
  try {
    const competition = await Competition.findOne({ isActive: true }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: competition });
  } catch (error) {
    return next(createError(500, "Failed to fetch active competition"));
  }
};

// Get All Competitions
export const getAllCompetitions = async (req, res, next) => {
  try {
    const competitions = await Competition.find();
    
    res.status(200).json({
      success: true,
      data: competitions,
    });
  } catch (error) {
    console.error("Error fetching competitions:", error);
    next(createError(500, "Failed to fetch competitions"));
  }
};

// Get Single Competition
export const getCompetitionById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const competition = await Competition.findById(id);

    if (!competition) {
      return next(createError(404, "Competition not found"));
    }

    res.status(200).json({
      success: true,
      data: competition,
    });
  } catch (error) {
    console.error("Error fetching competition:", error);
    next(createError(500, "Failed to fetch competition"));
  }
};

// Delete Competition
export const deleteCompetition = async (req, res, next) => {
  try {
    const { id } = req.params;

    const competition = await Competition.findByIdAndDelete(id);

    if (!competition) {
      return next(createError(404, "Competition not found"));
    }

    res.status(200).json({
      success: true,
      message: "Competition deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting competition:", error);
    next(createError(500, "Failed to delete competition"));
  }
};



