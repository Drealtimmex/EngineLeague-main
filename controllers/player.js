import Player from "../models/Player.js";
import Team from "../models/Team.js";
import User from "../models/User.js";
import { createError } from "../error.js";// Ensure this is imported or implemented
//tmeporary
export const tempcreatePlayer = async (req, res, next) => {
  try {
    const { name, teamId, position ,preferredFoot} = req.body;

    if (!name || !teamId || !position || !preferredFoot) {
      return next(createError(400, "All fields (name, teamId, position) are required"));
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return next(createError(404, "Team not found"));
    }

    const newPlayer = new Player({ name, team: teamId, position ,preferredFoot});
    const savedPlayer = await newPlayer.save();

    team.players.push(savedPlayer._id);
    await team.save();

    res.status(201).json({
      success: true,
      message: "Player successfully registered and added to team",
      data: savedPlayer,
    });
  } catch (err) {
    next(err);
  }
};

// Create a new Player and add to Team
export const createPlayer = async (req, res, next) => {
    try {
      const user = await User.findById(req.user.id);
  
      if (!user) {
        return next(createError(404, "User not found"));
      }
  
      if (user.role !== "admin") {
        return next(createError(403, "You are not authorized to register a player"));
      }
  
      const { name, teamId, position, playerPic } = req.body;
  
      if (!name || !teamId || !position || !playerPic) {
        return next(createError(400, "All fields (name, teamId, position, playerPic) are required"));
      }
  
      const team = await Team.findById(teamId);
  
      if (!team) {
        return next(createError(404, "Team not found"));
      }
  
      const newPlayer = new Player({ name, team: teamId, position, playerPic });
      const savedPlayer = await newPlayer.save();
  
      team.players.push(savedPlayer._id);
      await team.save();
  
      res.status(201).json({
        success: true,
        message: "Player successfully created and added to team",
        data: savedPlayer,
      });
    } catch (err) {
      next(err);
    }
  };

// Get a single Player by ID
export const getPlayer = async (req, res, next) => {
    try {
      const { id } = req.params;
      const player = await Player.findById(id).populate("team");
  
      if (!player) {
        return next(createError(404, "Player not found"));
      }
  
      res.status(200).json({ success: true, data: player });
    } catch (err) {
      next(err);
    }
  };
  
  // Get all Players belonging to a Team with filters
  export const getPlayersByTeam = async (req, res, next) => {
    try {
      const { teamId } = req.params;
      const { position, goals, assists, price, yellowCards, redCards } = req.query;
  
      // Initialize filters
      const filters = { team: teamId };
      if (position) filters.position = position;
      if (goals) filters.goals = { $gte: goals };
      if (assists) filters.assists = { $gte: assists };
      if (price) filters.price = { $lte: price };
      if (yellowCards) filters.totalyellowCards = { $gte: yellowCards };
      if (redCards) filters.totalredCards = { $gte: redCards };
  
      // Determine the sorting criteria only if at least one sorting query is provided
      let sortCriteria = {};
      if (goals) sortCriteria = { goals: -1 };
      else if (assists) sortCriteria = { assists: -1 };
      else if (price) sortCriteria = { price: 1 }; // Assuming ascending order for price
      else if (yellowCards) sortCriteria = { totalyellowCards: -1 };
      else if (redCards) sortCriteria = { totalredCards: -1 };
  
      // Fetch and sort players
      const players = await Player.find(filters).sort(sortCriteria);
  
      res.status(200).json({ success: true, data: players });
    } catch (err) {
      next(err);
    }
  };
  
  // Get all Players across all Teams with filters
  export const getAllPlayers = async (req, res, next) => {
    try {
      const { position, goals, assists, price, yellowCards, redCards } = req.query;
  
      // Initialize filters
      const filters = {};
      if (position) filters.position = position;
      if (goals) filters.goals = { $gte: goals };
      if (assists) filters.assists = { $gte: assists };
      if (price) filters.price = { $lte: price };
      if (yellowCards) filters.totalyellowCards = { $gte: yellowCards };
      if (redCards) filters.totalredCards = { $gte: redCards };
  
      // Determine the sorting criteria
      const sortField = goals
        ? "goals"
        : assists
        ? "assists"
        : price
        ? "price"
        : yellowCards
        ? "totalyellowCards"
        : redCards
        ? "totalredCards"
        : null;
  
      const sortCriteria = sortField ? { [sortField]: -1 } : {};
  
      // Fetch and sort players
      const players = await Player.find(filters).sort(sortCriteria);
  
      res.status(200).json({ success: true, data: players });
    } catch (err) {
      next(err);
    }
  };
  
  