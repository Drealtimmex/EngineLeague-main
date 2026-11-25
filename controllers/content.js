import mongoose from "mongoose";
import Article from "../models/Article.js";
import Poll from "../models/Poll.js";
import PollVote from "../models/PollVote.js";
import Announcement from "../models/Announcement.js";
import User from "../models/User.js";
import { createError } from "../error.js";

async function requireAdmin(req) {
  const user = req.user?.role ? req.user : await User.findById(req.user?.id).select("role").lean().exec();
  if (user?.role !== "admin") throw createError(403, "Admin access required");
}
const slugify = (value) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 150);
const safeUrl = (value) => {
  if (!value) return "";
  const text = String(value).trim();
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  try { const url = new URL(text); return url.protocol === "https:" ? url.toString() : ""; } catch { return ""; }
};
function articlePayload(body = {}) {
  const media = Array.isArray(body.media) ? body.media.slice(0, 20).map((item) => ({ type: item.type, url: safeUrl(item.url), caption: String(item.caption || "").slice(0, 240) })) : [];
  if (media.some((item) => !["image", "video", "embed"].includes(item.type) || !item.url)) throw createError(400, "Media items need a supported type and a secure URL");
  return {
    title: String(body.title || "").trim(), excerpt: String(body.excerpt || "").trim(), body: String(body.body || "").trim(),
    coverImage: safeUrl(body.coverImage), media, poll: body.poll && mongoose.isValidObjectId(body.poll) ? body.poll : null,
    status: body.status === "published" ? "published" : "draft",
  };
}

export async function listArticles(req, res, next) {
  try {
    const isAdminListing = req.path.endsWith("/admin") || req.query.admin === "true";
    const filter = isAdminListing ? (await requireAdmin(req), {}) : { status: "published", publishedAt: { $lte: new Date() } };
    const data = await Article.find(filter).sort({ publishedAt: -1, createdAt: -1 }).populate("poll", "question options resultsVisibility closesAt active").lean().exec();
    res.json({ success: true, data });
  } catch (error) { next(error); }
}
export async function getArticle(req, res, next) {
  try {
    const data = await Article.findOne({ slug: req.params.slug, status: "published", publishedAt: { $lte: new Date() } }).populate("poll", "question description options resultsVisibility opensAt closesAt active").lean().exec();
    if (!data) throw createError(404, "Article not found");
    res.json({ success: true, data });
  } catch (error) { next(error); }
}
export async function saveArticle(req, res, next) {
  try {
    await requireAdmin(req);
    const payload = articlePayload(req.body);
    if (!payload.title || !payload.body) throw createError(400, "Title and article body are required");
    const slug = slugify(req.body.slug || payload.title);
    if (!slug) throw createError(400, "Article slug is invalid");
    payload.slug = slug;
    payload.author = req.user.id;
    if (payload.status === "published") payload.publishedAt = new Date();
    const article = req.params.id
      ? await Article.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, runValidators: true }).lean().exec()
      : await Article.create(payload);
    if (!article) throw createError(404, "Article not found");
    res.status(req.params.id ? 200 : 201).json({ success: true, data: article });
  } catch (error) { next(error); }
}
export async function deleteArticle(req, res, next) {
  try { await requireAdmin(req); const data = await Article.findByIdAndDelete(req.params.id).lean().exec(); if (!data) throw createError(404, "Article not found"); res.json({ success: true }); } catch (error) { next(error); }
}

async function pollView(poll, userId, isAdmin = false) {
  const vote = userId ? await PollVote.findOne({ poll: poll._id, user: userId }).select("option").lean().exec() : null;
  const closed = !poll.active || (poll.closesAt && new Date(poll.closesAt) <= new Date());
  const canSee = isAdmin || poll.resultsVisibility === "live" || (poll.resultsVisibility === "after-vote" && !!vote) || (poll.resultsVisibility === "after-close" && !!closed);
  let results = null;
  if (canSee) {
    const rows = await PollVote.aggregate([{ $match: { poll: poll._id } }, { $group: { _id: "$option", votes: { $sum: 1 } } }]);
    const counts = new Map(rows.map((r) => [String(r._id), r.votes]));
    results = { total: rows.reduce((sum, row) => sum + row.votes, 0), options: poll.options.map((option) => ({ optionId: option._id, votes: counts.get(String(option._id)) || 0 })) };
  }
  return { ...poll, hasVoted: !!vote, selectedOption: vote?.option || null, resultsVisible: canSee, results };
}
export async function listPolls(req, res, next) {
  try {
    const isAdminListing = req.path.endsWith("/admin");
    if (isAdminListing) await requireAdmin(req);
    const polls = await Poll.find(isAdminListing ? {} : { active: true, opensAt: { $lte: new Date() } }).sort({ createdAt: -1 }).limit(100).lean().exec();
    const data = await Promise.all(polls.map((poll) => pollView(poll, req.user?.id, isAdminListing)));
    res.json({ success: true, data });
  } catch (error) { next(error); }
}
export async function createPoll(req, res, next) {
  try {
    await requireAdmin(req);
    const options = Array.isArray(req.body?.options) ? req.body.options.map((item) => ({ label: String(item.label || item).trim() })).filter((item) => item.label) : [];
    if (!req.body?.question?.trim() || options.length < 2 || options.length > 100) throw createError(400, "Polls need a question and 2 to 100 options");
    const poll = await Poll.create({ question: req.body.question.trim(), description: String(req.body.description || ""), options, resultsVisibility: ["live", "after-vote", "after-close", "hidden"].includes(req.body.resultsVisibility) ? req.body.resultsVisibility : "live", opensAt: req.body.opensAt || new Date(), closesAt: req.body.closesAt || null, active: req.body.active !== false, createdBy: req.user.id });
    res.status(201).json({ success: true, data: poll });
  } catch (error) { next(error); }
}
export async function votePoll(req, res, next) {
  try {
    const { optionId } = req.body || {};
    const poll = await Poll.findById(req.params.id).lean().exec();
    if (!poll || !poll.active || new Date(poll.opensAt) > new Date() || (poll.closesAt && new Date(poll.closesAt) <= new Date())) throw createError(409, "This poll is closed");
    if (!mongoose.isValidObjectId(optionId) || !poll.options.some((option) => String(option._id) === String(optionId))) throw createError(400, "Choose an option from this poll");
    await PollVote.init();
    if (await PollVote.exists({ poll: poll._id, user: req.user.id })) throw createError(409, "You have already voted in this poll");
    try { await PollVote.create({ poll: poll._id, user: req.user.id, option: optionId }); }
    catch (error) { if (error?.code === 11000) throw createError(409, "You have already voted in this poll"); throw error; }
    res.status(201).json({ success: true, data: await pollView(poll, req.user.id) });
  } catch (error) { next(error); }
}

export async function listAnnouncements(req, res, next) {
  try {
    const now = new Date();
    const data = await Announcement.find({ active: true, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }).sort({ createdAt: -1 }).limit(30).lean().exec();
    res.json({ success: true, data });
  } catch (error) { next(error); }
}
export async function createAnnouncement(req, res, next) {
  try {
    await requireAdmin(req);
    const { title, message } = req.body || {};
    if (!title?.trim() || !message?.trim()) throw createError(400, "Notification title and message are required");
    const href = String(req.body.href || "");
    if (href && (!href.startsWith("/") || href.startsWith("//"))) throw createError(400, "Notification links must be internal paths");
    const data = await Announcement.create({ title: title.trim(), message: message.trim(), type: ["general", "goal", "postponement", "competition", "poll"].includes(req.body.type) ? req.body.type : "general", href, startsAt: req.body.startsAt || new Date(), endsAt: req.body.endsAt || null, active: true, createdBy: req.user.id });
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
}
export async function updateAnnouncement(req, res, next) {
  try { await requireAdmin(req); const data = await Announcement.findByIdAndUpdate(req.params.id, { $set: { active: !!req.body?.active } }, { new: true }).lean().exec(); if (!data) throw createError(404, "Notification not found"); res.json({ success: true, data }); } catch (error) { next(error); }
}
