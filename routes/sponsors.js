import express from "express";
import { verifyToken } from "../verifyToken.js";
import { createSponsor, deleteSponsor, getSponsor, listSponsorApplications, listSponsors, submitSponsorApplication, updateSponsor, updateSponsorApplication } from "../controllers/sponsors.js";

const router = express.Router();
router.get("/", listSponsors);
router.post("/applications", submitSponsorApplication);
router.get("/applications", verifyToken, listSponsorApplications);
router.patch("/applications/:id", verifyToken, updateSponsorApplication);
router.get("/:id", getSponsor);
router.post("/", verifyToken, createSponsor);
router.put("/:id", verifyToken, updateSponsor);
router.delete("/:id", verifyToken, deleteSponsor);

export default router;
