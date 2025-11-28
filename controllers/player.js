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
  
      if (!name || !teamId || !position ) {
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
    if (!teamId) return next(createError(400, "teamId required"));

    const { position, goals, assists, price, yellowCards, redCards } = req.query;

    // Build filters
    const filters = { team: teamId };
    if (position) filters.position = position;
    if (goals) filters.goals = { $gte: Number(goals) };
    if (assists) filters.assists = { $gte: Number(assists) };
    if (price) filters.price = { $lte: Number(price) };
    if (yellowCards) filters.totalyellowCards = { $gte: Number(yellowCards) };
    if (redCards) filters.totalredCards = { $gte: Number(redCards) };

    // Fetch players (no DB-side sort by position since it's easier to control in JS)
    const players = await Player.find(filters).lean();

    // Helper: position priority and grouping
    const posPriority = (pos) => {
      if (!pos) return 999;
      const p = String(pos).toUpperCase();
      if (p.startsWith("GK") || p.includes("GOAL")) return 0;

      if (p.includes("CB")) return 10;
      if (p.includes("LB")) return 11;
      if (p.includes("RB")) return 12;
      if (p.includes("LWB")) return 13;
      if (p.includes("RWB")) return 14;
      // defenders fallback
      if (["DEF","DF"].some(x => p.includes(x))) return 15;

      if (p.includes("CM")) return 20;
      if (p.includes("DM")) return 21;
      if (p.includes("AM")) return 22;
      if (p.includes("LM")) return 23;
      if (p.includes("RM")) return 24;
      if (["MID","MF"].some(x => p.includes(x))) return 25;

      if (p.includes("ST")) return 30;
      if (p.includes("CF")) return 31;
      if (p.includes("FW") || p.includes("FWD")) return 32;
      if (p.includes("LW")) return 33;
      if (p.includes("RW")) return 34;

      return 999;
    };

    const toGroup = (pos) => {
      if (!pos) return "OTHER";
      const p = String(pos).toUpperCase();
      if (p.includes("GK") || p.includes("GOAL")) return "GK";
      if (["CB","LB","RB","LWB","RWB","WB","DEF","DF"].some(k => p.includes(k))) return "DEF";
      if (["CM","DM","AM","LM","RM","MF","MID"].some(k => p.includes(k))) return "MID";
      if (["ST","CF","FW","ATT","FWD","LW","RW"].some(k => p.includes(k))) return "ATT";
      return "OTHER";
    };

    // sort players in-memory: by posPriority -> number -> name
    players.sort((a, b) => {
      const pa = posPriority(a.position);
      const pb = posPriority(b.position);
      if (pa !== pb) return pa - pb;

      const na = Number(a.number ?? 999);
      const nb = Number(b.number ?? 999);
      if (na !== nb) return na - nb;

      const an = String(a.name ?? "").localeCompare(String(b.name ?? ""));
      return an;
    });

    // group
    const grouped = { GK: [], DEF: [], MID: [], ATT: [], OTHER: [] };
    for (const p of players) {
      const g = toGroup(p.position);
      grouped[g].push(p);
    }

    return res.status(200).json({ success: true, data: { flat: players, grouped } });
  } catch (err) {
    console.error("[getPlayersByTeam] error:", err);
    next(err);
  }
};

// Get all Players across all Teams with filters (populate team.name)
export const getAllPlayers = async (req, res, next) => {
  try {
    const { position, goals, assists, price, yellowCards, redCards } = req.query;

    // build filters safely (convert numeric strings to numbers)
    const filters = {};
    if (position) filters.position = position;
    if (goals) filters.goals = { $gte: Number(goals) };
    if (assists) filters.assists = { $gte: Number(assists) };
    if (price) filters.price = { $lte: Number(price) };
    if (yellowCards) filters.totalyellowCards = { $gte: Number(yellowCards) };
    if (redCards) filters.totalredCards = { $gte: Number(redCards) };

    // sort field
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

    // fetch players and populate the team name only
    const players = await Player.find(filters)
      .sort(sortCriteria)
      .populate("team", "name") // <- this populates team with only `name`
      .lean(); // returns plain JS objects and is faster for read-only

    res.status(200).json({ success: true, data: players });
  } catch (err) {
    next(err);
  }
};
  
  export const deletePlayer = async (req, res, next) => {
    try {
      const { id } = req.params;
  
      const player = await Player.findByIdAndDelete(id);
  
      if (!player) {
        return next(createError(404, "Player not found"));
      }
  
      res.status(200).json({
        success: true,
        message: "Player deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting Player:", error);
      next(createError(500, "Failed to delete Player"));
    }
  };