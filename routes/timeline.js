// routes/timeline.js
import express from "express";
import { createTimeline, getTimelinesByMatch, deleteTimeline, updateTimeline } from "../controllers/timeline.js";
import { verifyToken } from "../verifyToken.js";

const router = express.Router();

// Create entry (protected)
router.post("/", verifyToken, createTimeline);

// Get all timeline entries for a match (public)
router.get("/match/:matchId", getTimelinesByMatch);

// Update timeline entry (protected)
router.put("/:id", verifyToken, updateTimeline);

// Delete timeline entry (protected)
router.delete("/:id", verifyToken, deleteTimeline);

export default router;
