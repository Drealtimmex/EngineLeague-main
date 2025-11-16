import express from "express";
import { googleAuth, signIn, signOut, signUp} from "../controllers/auth.js";

const router = express.Router();

// Sign-in Route
router.post("/signin", signIn);
//resend code


// Sign-Up Route
router.post("/signup", signUp);

// Google Authentication Route
router.post("/google", googleAuth);

// Sign-Out Route
router.delete("/signout/:email", signOut);

export default router;
