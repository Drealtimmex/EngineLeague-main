// routes/fantasy.js
import express from "express";
import {
  createFantasyTeam,
  editFantasyTeam,
  makeTransfers,
  setLineup,
  getAllFantasyTeams,
  getFantasyTeamById,
  getFantasyTeamByLoggedId,
  deleteTeam,
  substitutePlayers,
  setCaptainVice,
} from "../controllers/fantasy.js";
import { verifyToken } from "../verifyToken.js";

const router = express.Router();

// Public reads
router.get("/", getAllFantasyTeams); // optional query: ?userId=&competitionId=
router.get("/:id", getFantasyTeamById);
router.get("/get/team", verifyToken , getFantasyTeamByLoggedId);
router.delete("/", verifyToken , deleteTeam);
// Protected actions
router.post("/", verifyToken, createFantasyTeam); // create new fantasy team
router.put("/edit", verifyToken, editFantasyTeam); // edit metadata or replace squad
router.post("/transfers", verifyToken, makeTransfers); // make transfers
router.post("/lineup", verifyToken, setLineup);
 // set starting 11 + captain/vice
 // substitute// set captain / vice
router.post("/set-captain", verifyToken, setCaptainVice);
router.post("/substitute", verifyToken, substitutePlayers);


export default router;
