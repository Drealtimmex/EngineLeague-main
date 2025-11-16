// routes/analytics.js
import express from "express";
import { getMostSignedPlayers } from "../controllers/analytics.js";
import { verifyToken } from "../verifyToken.js"; // optional if you want auth for analytics

const router = express.Router();

// Public analytics endpoint
// Example: GET /api/analytics/most-signed?gameweek=3&position=DEF&competitionId=...&limit=20
router.get("/most-signed", getMostSignedPlayers);

export default router;
