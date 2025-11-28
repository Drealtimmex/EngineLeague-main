import express from "express";
import { createPlayer,getAllPlayers,getPlayer,getPlayersByTeam,tempcreatePlayer,deletePlayer} from "../controllers/player.js";
import { verifyToken } from "../verifyToken.js";

const router = express.Router();

// create
router.post("/", verifyToken, createPlayer);
router.post("/temp", tempcreatePlayer);
//get
router.get("/:id", getPlayer);
router.get("/", getAllPlayers);
router.get("/team/:teamId",getPlayersByTeam)
router.delete("/:id",deletePlayer)

export default router;
