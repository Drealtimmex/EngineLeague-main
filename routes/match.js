import express from "express";
import { getGameweeksWithMatches,getSingleMatchById,updateMatch} from "../controllers/match.js";
import { verifyToken } from "../verifyToken.js";

const router = express.Router();

// get
router.get("/", getGameweeksWithMatches);
router.get("/:id",getSingleMatchById)
//update
router.put("/",verifyToken, updateMatch);


export default router;
