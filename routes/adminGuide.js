import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import User from "../models/User.js";
import { createError } from "../error.js";
import { verifyToken } from "../verifyToken.js";

const router = express.Router();
const routeDirectory = path.dirname(fileURLToPath(import.meta.url));
const guidePdf = path.resolve(routeDirectory, "../docs/admin-operations-guide.pdf");

router.get("/pdf", verifyToken, async (req, res, next) => {
  try {
    const user = req.user?.id ? await User.findById(req.user.id).select("role").lean() : null;
    if (!user || user.role !== "admin") return next(createError(403, "Administrator access required"));
    return res.download(guidePdf, "Esport-Engine-Admin-Operations-Guide.pdf", (error) => {
      if (error && !res.headersSent) next(createError(404, "Admin guide PDF is not available"));
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
