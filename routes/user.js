import express from "express";
import { verifyToken } from "../verifyToken.js";
import {
  deleteUser,
  getAllUsers,
  getSingleUser,
  recoverPassword,
  resetPassword,
  updateUser,
  getCurrentUser,
  getSingleUserSignin,
  changePassword,updateProfilePicture
} from "../controllers/user.js";

const router = express.Router();
//get current us
router.get("/get/me", verifyToken, getCurrentUser);
router.put("/password", verifyToken, changePassword);
// for signin
router.post("/get/me", getSingleUserSignin);
// Update User
router.put("/:email", verifyToken, updateUser);
router.put("/profile", verifyToken, updateProfilePicture);

// Get a signle user
router.get("/find/:email", verifyToken, getSingleUser);

// Get all users
router.get("/getAll", verifyToken, getAllUsers);

// Delete a user
router.delete("/:email", verifyToken, deleteUser);

// Reset user password
router.post("/reset/",  resetPassword);

// Recover user password
router.get("/recover/:email",  recoverPassword);

export default router;
