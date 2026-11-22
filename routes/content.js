import express from "express";
import { verifyToken } from "../verifyToken.js";
import { createAnnouncement, createPoll, deleteArticle, getArticle, listAnnouncements, listArticles, listPolls, saveArticle, updateAnnouncement, votePoll } from "../controllers/content.js";

const router = express.Router();
router.get("/articles", listArticles);
router.get("/articles/admin", verifyToken, listArticles);
router.get("/articles/:slug", getArticle);
router.post("/articles", verifyToken, saveArticle);
router.put("/articles/:id", verifyToken, saveArticle);
router.delete("/articles/:id", verifyToken, deleteArticle);
router.get("/polls", listPolls);
router.get("/polls/admin", verifyToken, listPolls);
router.post("/polls", verifyToken, createPoll);
router.post("/polls/:id/votes", verifyToken, votePoll);
router.get("/notifications", listAnnouncements);
router.post("/notifications", verifyToken, createAnnouncement);
router.patch("/notifications/:id", verifyToken, updateAnnouncement);
export default router;
