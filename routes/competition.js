import express from "express";
import {createCompetition, getAllCompetitions, getCompetitionById, deleteCompetition} from "../controllers/competition.js";
import { verifyToken } from "../verifyToken.js";

const router = express.Router();

// create
router.post("/", verifyToken, createCompetition);

router.get("/", getAllCompetitions);
router.get("/:id", getCompetitionById);
router.delete("/:id", deleteCompetition);

export default router;
