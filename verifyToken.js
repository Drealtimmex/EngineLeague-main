// middleware/verifyToken.js
import jwt from "jsonwebtoken";
import { createError } from "./error.js";

export const verifyToken = (req, res, next) => {
  try {
    // 1) try cookie first
    let token = req.cookies?.access_token;

    // 2) fallback to Authorization header: "Bearer <token>"
    if (!token && req.headers?.authorization) {
      const parts = String(req.headers.authorization).split(" ");
      if (parts.length === 2 && /^Bearer$/i.test(parts[0])) token = parts[1];
    }

    if (!token) return next(createError(401, "You are not authenticated!"));

    jwt.verify(token, process.env.JWT, (err, decoded) => {
      if (err) {
        // give a clearer response for expired tokens
        if (err.name === "TokenExpiredError") return next(createError(401, "Token expired"));
        return next(createError(403, "Token is not valid!"));
      }

      // decoded is the payload you signed: { id: user._id, iat: ..., exp: ... }
      req.user = decoded;
      // convenience: req.userId is often used
      req.userId = decoded?.id;
      next();
    });
  } catch (err) {
    next(createError(500, "Internal auth error"));
  }
};
