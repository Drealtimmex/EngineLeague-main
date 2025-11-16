import Competition from "../models/Competition.js"
import User from "../models/User.js"
import { createError } from "../error.js";

// Create Team
export const createCompetition = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);

    // Verify if the user is an admin
    if (!user || user.role !== "admin") {
      return next(createError(403, "Only admins can create teams"));
    }

    const { name,logo } = req.body;

    // Create a new team
    const newCompetition = await Competition.create({ name, logo});

    res.status(201).json({
      success: true,
      data: newCompetition,
    });
  } catch (error) {
    console.error("Error creating team:", error);
    next(createError(500, "Failed to create team"));
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



