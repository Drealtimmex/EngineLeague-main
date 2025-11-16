// routes/fixtures.js
import express from "express";
import {
  generateFixturesAuto,
  createFixturesManually,
  generatePartialFixtures,
  createKnockoutPlaceholders,
  fillKnockoutFixtures, getPlaceholdersByCompetition
} from "../controllers/fixture.js";
import { verifyToken } from "../verifyToken.js";

const router = express.Router();

// Admin-only endpoints (verifyToken required)
router.get("/placeholder",verifyToken,getPlaceholdersByCompetition)
router.post("/generate", verifyToken, generateFixturesAuto); // auto generate first R rounds
router.post("/manual", verifyToken, createFixturesManually); // manual create gw/fixtures
router.post("/generate-partial", verifyToken, generatePartialFixtures); // partial
router.post("/knockout/placeholders", verifyToken, createKnockoutPlaceholders); // create knockout placeholders
router.post("/knockout/fill", verifyToken, fillKnockoutFixtures); // fill knockout fixtures with teams

export default router;
