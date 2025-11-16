// controllers/auth.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createError } from "../error.js";
import User from "../models/User.js";

/**
 * Helper: detect secure requests (works behind proxies)
 */
function isSecureRequest(req) {
  return Boolean(
    req.secure ||
      (req.headers && req.headers["x-forwarded-proto"] === "https") ||
      process.env.NODE_ENV === "production"
  );
}

/**
 * Cookie options helper. Optionally uses COOKIE_DOMAIN env var.
 * Returns an object safe for res.cookie and res.clearCookie
 */
function cookieOptions(req) {
  const isProd = process.env.NODE_ENV === "production";

  const opts = {
    httpOnly: true,
    secure: isProd, // only true in production
    sameSite: isProd ? "none" : "lax", // none for cross-origin prod, lax for localhost
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  };
  if (process.env.COOKIE_DOMAIN && !process.env.COOKIE_DOMAIN.includes("localhost")) {
    opts.domain = process.env.COOKIE_DOMAIN;
  }

  return opts;
}

/**
 * SIGN-IN
 * - verifies email + password
 * - issues cookie AND returns token in response for header fallback
 */
export const signIn = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email) return next(createError(400, "Email is required"));
    if (!password) return next(createError(400, "Password is required"));

    const user = await User.findOne({ email }).select("+password");
    if (!user) return next(createError(404, "User not found"));

    // If user registered via Google only and has no password
    if (!user.password && user.fromGoogle) {
      return next(createError(401, "Please sign in with Google"));
    }

    const match = await bcrypt.compare(password, user.password || "");
    if (!match) return next(createError(400, "Wrong credentials"));

    const token = jwt.sign({ id: user._id }, process.env.JWT, { expiresIn: "30d" });

    // remove sensitive fields from returned user object
    const userObj = user.toObject();
    delete userObj.password;

    res.cookie("access_token", token, cookieOptions(req));
    return res.status(200).json({ user: userObj, token });
  } catch (err) {
    console.error("[signIn] unexpected error:", err);
    next(err);
  }
};

/**
 * Utilities for signup username generation
 */
function randomSuffix(len = 6) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function generateUniqueUsername(prefix = "user", maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = `${prefix}${randomSuffix(6)}`;
    const exists = await User.findOne({ username: candidate }).lean().select("_id").exec();
    if (!exists) return candidate;
  }
  return `${prefix}${Date.now()}`;
}

/**
 * SIGN-UP
 * - create user with email + password (password optional for Google-only flows elsewhere)
 * - returns user + token (no cookie set on signup by design, but you can change if desired)
 */
export const signUp = async (req, res, next) => {
  try {
    const { email, username: incomingUsername, password } = req.body;

    if (!email) return next(createError(400, "Email is required"));
    if (!password) return next(createError(400, "Password is required"));

    let username =
      typeof incomingUsername === "string" && incomingUsername.trim()
        ? incomingUsername.trim()
        : null;

    if (!username) {
      username = await generateUniqueUsername("user");
    } else {
      username = username.replace(/\s+/g, "").toLowerCase();
      const taken = await User.findOne({ username }).lean().select("_id").exec();
      if (taken) {
        username = await generateUniqueUsername(username.slice(0, 6) || "user");
      }
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    const userDoc = {
      ...req.body,
      username,
      password: hash,
    };

    // Remove any untrusted fields
    delete userDoc._id;
    delete userDoc._doc;

    const saved = await new User(userDoc).save();

    const token = jwt.sign({ id: saved._id }, process.env.JWT, { expiresIn: "30d" });

    const userObj = saved.toObject();
    delete userObj.password;

    return res.status(201).json({ user: userObj, token });
  } catch (err) {
    // Duplicate key (unique) error handling
    if (err && err.code === 11000) {
      const key = err.keyValue ? Object.keys(err.keyValue)[0] : "field";
      const val = err.keyValue ? err.keyValue[key] : undefined;
      return res.status(409).json({
        success: false,
        status: 409,
        message:
          key === "email"
            ? "Email already in use"
            : key === "username"
            ? "Username already in use"
            : `Duplicate ${key}`,
        field: key,
        value: val,
      });
    }
    next(err);
  }
};

/**
 * GOOGLE AUTH
 * - sets cookie and returns token + user in response
 * Note: this flow creates a user with fromGoogle=true and no password.
 */
export const googleAuth = async (req, res, next) => {
  try {
    const { email, googleId } = req.body;
    if (!email || !googleId) return next(createError(400, "Email and googleId are required"));

    let user = await User.findOne({ email });
    if (user) {
      // If existing user is a google account, ensure googleId matches
      if (user.fromGoogle && user.googleId && user.googleId !== googleId) {
        return next(createError(400, "Google ID mismatch"));
      }

      // If existing user has password (registered via email/password), you may decide
      // whether to allow linking. For now we permit returning token for existing user.
      const token = jwt.sign({ id: user._id }, process.env.JWT, { expiresIn: "30d" });
      res.cookie("access_token", token, cookieOptions(req));
      const userObj = user.toObject();
      delete userObj.password;
      return res.status(200).json({ user: userObj, token });
    }

    // Create new Google-only user
    const newUser = new User({
      email,
      googleId,
      fromGoogle: true,
      // you may want to generate a username for them:
      username: await generateUniqueUsername("google"),
    });

    const savedUser = await newUser.save();
    const token = jwt.sign({ id: savedUser._id }, process.env.JWT, { expiresIn: "30d" });

    res.cookie("access_token", token, cookieOptions(req));
    const userObj = savedUser.toObject();
    delete userObj.password;

    return res.status(200).json({ user: userObj, token });
  } catch (err) {
    console.error("[googleAuth] error:", err);
    next(err);
  }
};

/**
 * SIGN OUT
 * - clears cookie (uses same options so browser actually clears it)
 * - returns success message
 */
export const signOut = async (req, res, next) => {
  try {
    res.clearCookie("access_token", cookieOptions(req));
    return res.status(200).json({
      message: "User logged out successfully",
    });
  } catch (err) {
    next(err);
  }
};
