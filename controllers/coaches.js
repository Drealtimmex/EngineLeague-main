import User from "../models/User.js"
import Team from "../models/Team.js";
import Coach from "../models/Coaches.js";
import {createError} from "../error.js";
 // Create a new Coach and assign to Team
 export const createCoach = async (req, res, next) => {
  try {
    const { name, teamId, coachpic, experience, assistant } = req.body;

    // Check if the user is an admin
    const user = await User.findById(req.user.id);
    if (!user) {
      return next(createError(404, "User not found"));
    }
    if (user.role !== "admin") {
      return next(createError(403, "You are not authorized to register a coach"));
    }

    // Validate required fields
    if (!name || !teamId) {
      return next(createError(400, "Name and teamId are required"));
    }

    // Check if the team exists
    const team = await Team.findById(teamId);
    if (!team) {
      return next(createError(404, "Team not found"));
    }

    // Create and save the new coach
    const newCoach = new Coach({
      name,
      team: teamId,
      pic: coachpic,
      experience,
      assistant: {
        name: assistant?.name,
        pic: assistant?.pic,
      },
    });
    const savedCoach = await newCoach.save();

    // Assign the coach to the team
    team.coach = savedCoach._id;
    await team.save();

    res.status(201).json({
      success: true,
      message: "Coach successfully created and assigned to team",
      data: savedCoach,
    });
  } catch (err) {
    console.error("Error creating coach:", err);
    next(err);
  }
};



// Get a single Coach by ID
export const getCoach = async (req, res, next) => {
    try {
      const { id } = req.params;
      const coach = await Coach.findById(id).populate("team");
  
      if (!coach) {
        return next(createError(404, "Coach not found"));
      }
  
      res.status(200).json({ success: true, data: coach });
    } catch (err) {
      next(err);
    }
  };
  
  // Update Coach
  export const updateCoach = async (req, res, next) => {
    try {
      const { id } = req.params;
      const user = await User.findById(req.user.id);
  
      if (!user) {
        return next(createError(404, "User not found"));
      }
  
      if (user.role !== "admin") {
        return next(createError(403, "You are not authorized to register a coach"));
      }
      const updatedCoach = await Coach.findByIdAndUpdate(id, req.body, {
        new: true,
        runValidators: true,
      });
  
      if (!updatedCoach) {
        return next(createError(404, "Coach not found"));
      }
  
      res.status(200).json({ success: true, data: updatedCoach });
    } catch (err) {
      next(err);
    }
  };
  
  