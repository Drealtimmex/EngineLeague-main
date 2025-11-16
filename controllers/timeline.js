// controllers/timeline.js
import { createError } from "../error.js";
import Timeline from "../models/Timeline.js";
import Match from "../models/Match.js";
import mongoose from "mongoose";

/**
 * Create timeline entry for a match
 * Body: { matchId, title, description, images: [url1, url2, ...] }
 * Protected: requires verifyToken (we assume req.user exists)
 * Optionally you can restrict to admins by checking user.role
 */
export const createTimeline = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const { matchId, title, description, images = [] } = req.body;

    if (!matchId) return next(createError(400, "matchId is required"));
    if (!title && !description && (!images || images.length === 0)) {
      return next(createError(400, "At least one of title/description/images is required"));
    }

    // validate match exists
    const match = await Match.findById(matchId);
    if (!match) return next(createError(404, "Match not found"));

    // create timeline document
    const timeline = new Timeline({
      title: title || "",
      description: description || "",
      images: Array.isArray(images) ? images : [],
      match: match._id,
      createdAt: new Date(),
    });

    const saved = await timeline.save();

    // push reference into match.timeline array (avoid duplicates)
    if (!Array.isArray(match.timeline)) match.timeline = [];
    match.timeline.push(saved._id);
    await match.save();

    // return created timeline (populate match field if desired)
    const populated = await Timeline.findById(saved._id).populate({
      path: "match",
      select: "homeTeam awayTeam date venue result",
    }).exec();

    return res.status(201).json({ success: true, data: populated });
  } catch (err) {
    console.error("[createTimeline] error:", err);
    next(err);
  }
};

/**
 * Get all timeline entries for a given match id
 * Query params: ?limit=&skip=&sort=asc|desc
 */
export const getTimelinesByMatch = async (req, res, next) => {
  try {
    const { matchId } = req.params;
    if (!matchId) return next(createError(400, "matchId required"));

    // Optional pagination
    const limit = parseInt(req.query.limit, 10) || 100;
    const skip = parseInt(req.query.skip, 10) || 0;
    const sortOrder = (req.query.sort === "asc") ? 1 : -1; // default newest first

    // Validate match
    const match = await Match.findById(matchId).select("_id");
    if (!match) return next(createError(404, "Match not found"));

    const timelines = await Timeline.find({ match: matchId })
      .sort({ createdAt: sortOrder })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    return res.status(200).json({ success: true, count: timelines.length, data: timelines });
  } catch (err) {
    console.error("[getTimelinesByMatch] error:", err);
    next(err);
  }
};

/**
 * Delete a timeline entry by id
 * Protected: verifyToken (you can also restrict to admin or the creator if you store creator on timeline)
 */
export const deleteTimeline = async (req, res, next) => {
  try {
    const timelineId = req.params.id;
    if (!timelineId) return next(createError(400, "timeline id required"));

    const timeline = await Timeline.findById(timelineId);
    if (!timeline) return next(createError(404, "Timeline not found"));

    // Optionally restrict deletion to admin or creator:
    // const user = await User.findById(req.user.id);
    // if (user.role !== "admin") return next(createError(403, "Only admin can delete"));

    // Remove timeline reference from the match.timeline array
    if (timeline.match) {
      await Match.updateOne(
        { _id: timeline.match },
        { $pull: { timeline: timeline._id } }
      ).exec();
    }

    await Timeline.deleteOne({ _id: timelineId }).exec();

    return res.status(200).json({ success: true, message: "Timeline deleted" });
  } catch (err) {
    console.error("[deleteTimeline] error:", err);
    next(err);
  }
};

/**
 * Optional: update a timeline entry
 * Body: { title?, description?, images? }
 */
export const updateTimeline = async (req, res, next) => {
  try {
    const timelineId = req.params.id;
    if (!timelineId) return next(createError(400, "timeline id required"));

    const { title, description, images } = req.body;
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (images !== undefined) updates.images = Array.isArray(images) ? images : [];

    const updated = await Timeline.findByIdAndUpdate(timelineId, { $set: updates }, { new: true }).exec();
    if (!updated) return next(createError(404, "Timeline not found"));
    return res.status(200).json({ success: true, data: updated });
  } catch (err) {
    console.error("[updateTimeline] error:", err);
    next(err);
  }
};
