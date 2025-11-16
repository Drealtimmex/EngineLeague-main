import express from "express";
import { createCoach,updateCoach,getCoach} from "../controllers/coaches.js";
import { verifyToken } from "../verifyToken.js";

const router = express.Router();

// create
router.post("/", verifyToken, createCoach);
//update
router.put("/:id",verifyToken, updateCoach);
router.get("/:id",getCoach)

export default router;
