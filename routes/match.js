import express from "express";
import { getGameweeksWithMatches,getMatchesByTeam,getSingleMatchById,revertMatchFulltime,revertMatchEvent,updateMatch} from "../controllers/match.js";
import { verifyToken } from "../verifyToken.js";
import { addMatchListener } from "../utils/liveMatchEvents.js";

const router = express.Router();

// get
router.get("/", getGameweeksWithMatches)
router.get("/team/:teamId", getMatchesByTeam);;
router.get("/events", (req, res) => {
  const matchId = String(req.query.matchId || "");
  if (!matchId) return res.status(400).end("matchId required");
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  res.write(`event: ready\ndata: ${JSON.stringify({ matchId })}\n\n`);
  const remove = addMatchListener(matchId, res);
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  req.on("close", () => { clearInterval(heartbeat); remove(); res.end(); });
});
router.get("/:id",getSingleMatchById)
//update
router.put("/",verifyToken, updateMatch);
router.post("/:id/revert-fulltime", verifyToken, revertMatchFulltime);
router.post("/:id/revert-event", verifyToken, revertMatchEvent);


export default router;
