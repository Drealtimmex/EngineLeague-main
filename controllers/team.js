import Team from "../models/Team.js"
import User from "../models/User.js"
import Match from "../models/Match.js"
import mongoose from "mongoose";
import Competition from "../models/Competition.js"
import { createError } from "../error.js";

// Create Team
export const createTeam = async (req, res, next) => {
  try {
    console.log("Request Body:", req.body); // Debugging

    const user = await User.findById(req.user.id);

    if (!user || user.role !== "admin") {
      return next(createError(403, "Only admins can create teams"));
    }

    const { name, logo, competitionId } = req.body;

    if (!competitionId) {
      return next(createError(400, "Competition ID is required"));
    }

    // Ensure competitionId is a valid ObjectId
    if (!mongoose.Types.ObjectId.isValid(competitionId)) {
      return next(createError(400, "Invalid Competition ID"));
    }

    const competition = await Competition.findById(competitionId);
    if (!competition) {
      return next(createError(404, "Competition not found"));
    }

    // Create a new team
    const newTeam = await Team.create({
      name,
      logo,
      competitionId: new mongoose.Types.ObjectId(competitionId), // Ensure it's stored correctly
    });

    // Add team to competition's teams array
    competition.teams.push(newTeam._id);
    await competition.save();

    res.status(201).json({
      success: true,
      data: newTeam,
    });
  } catch (error) {
    console.error("Error creating team:", error);
    next(createError(500, "Failed to create team"));
  }
};


// Update Team
export const updateTeam = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);

    // Verify if the user is an admin
    if (!user || user.role !== "admin") {
      return next(createError(403, "Only admins can update teams"));
    }

    const { teamId, updateData } = req.body;

    // Find and update the team
    const team = await Team.findByIdAndUpdate(teamId, updateData, { new: true });

    if (!team) {
      return next(createError(404, "Team not found"));
    }

    res.status(200).json({
      success: true,
      data: team,
    });
  } catch (error) {
    console.error("Error updating team:", error);
    next(createError(500, "Failed to update team"));
  }
};

// Get Single Team
export const getTeamById = async (req, res, next) => {
  try {
    const { teamId } = req.params;

    const team = await Team.findById(teamId)
      .populate("coach", "name")
      .populate("players", "name position");

    if (!team) {
      return next(createError(404, "Team not found"));
    }

    res.status(200).json({
      success: true,
      data: team,
    });
  } catch (error) {
    console.error("Error fetching team:", error);
    next(createError(500, "Failed to fetch team"));
  }
};
// Get Single Team
// export const getTeamByName = async (req, res, next) => {
//   try {
//     const { teamName } = req.params;

//     const team = await Team.findOne({name: teamName})
//       .populate("coach", "name")
//       .populate("players", "name position");

//     if (!team) {
//       return next(createError(404, "Team not found"));
//     }

//     res.status(200).json({
//       success: true,
//       data: team,
//     });
//   } catch (error) {
//     console.error("Error fetching team:", error);
//     next(createError(500, "Failed to fetch team"));
//   }
// };


// Get All Teams
export const getAllTeams = async (req, res, next) => {
  try {
    const teams = await Team.find()
      .populate("coach", "name")
      .populate("players", "name position");

    res.status(200).json({
      success: true,
      data: teams,
    });
  } catch (error) {
    console.error("Error fetching teams:", error);
    next(createError(500, "Failed to fetch teams"));
  }
};

export const getAllTeamsByCompetition = async (req, res, next) => {
  try {
    const { id: competitionId } = req.params; // Assuming competitionId is passed in the URL
console.log (`this is ${competitionId}`)
    if (!competitionId) {
      return next(createError(400, "Competition ID is required"));
    }

    const teams = await Team.find({ competitionId: competitionId }) // Assuming "competition" is a field in Team model
      .populate("coach", "name")
      .populate("players", "name position");

    if (!teams.length) {
      return next(createError(404, "No teams found for this competition"));
    }

    res.status(200).json({
      success: true,
      data: teams,
    });
  } catch (error) {
    console.error("Error fetching teams:", error);
    next(createError(500, "Failed to fetch teams"));
  }
};

