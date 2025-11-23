import express from "express";
import {getAllTeams,createTeam,updateTeam,getTeamById,getAllTeamsByCompetition} from "../controllers/team.js";
import { verifyToken } from "../verifyToken.js";

const router = express.Router();

// create
router.post("/", verifyToken, createTeam);
//get
router.get("/:teamId", getTeamById);
// router.get("/team/:name", getTeamByName);
router.get("/", getAllTeams);
router.get("/getAll/:id", getAllTeamsByCompetition);
router.put("/:id",updateTeam)

export default router;
