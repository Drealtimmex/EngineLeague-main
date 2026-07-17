import express from "express";
import { getGameweeksWithMatches,getMatchesByTeam,getSingleMatchById,revertMatchFulltime,updateMatch} from "../controllers/match.js";
import { verifyToken } from "../verifyToken.js";

const router = express.Router();

// get
router.get("/", getGameweeksWithMatches)
router.get("/team/:teamId", getMatchesByTeam);;
router.get("/:id",getSingleMatchById)
//update
router.put("/",verifyToken, updateMatch);
router.post("/:id/revert-fulltime", verifyToken, revertMatchFulltime);


export default router;
