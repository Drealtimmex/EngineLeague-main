import Sponsor from "../models/Sponsor.js";
import SponsorApplication from "../models/SponsorApplication.js";
import User from "../models/User.js";
import { createError } from "../error.js";

async function requireAdmin(req) {
  const user = req.user?.role ? req.user : await User.findById(req.user?.id).select("role").lean().exec();
  if (user?.role !== "admin") throw createError(403, "Admin access required");
}

const sponsorFields = ["name", "website", "logo", "tagline", "description", "placement", "active", "order"];
function pickSponsorFields(body) {
  return Object.fromEntries(sponsorFields.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
}

export async function listSponsors(req, res, next) {
  try {
    await Sponsor.updateOne(
      { name: "ServiceXpress" },
      { $setOnInsert: {
        website: "https://www.servicexpressng.com/",
        logo: "/images/servicexpress.jpg",
        tagline: "Connecting vendors with artisans",
        description: "ServiceXpress is an app that connects vendors with artisans.",
        placement: "featured",
        active: true,
        order: 0,
      } },
      { upsert: true },
    ).exec();
    const sponsors = await Sponsor.find({ active: true }).sort({ order: 1, createdAt: -1 }).lean().exec();
    res.json({ success: true, data: sponsors });
  } catch (error) { next(error); }
}

export async function createSponsor(req, res, next) {
  try {
    await requireAdmin(req);
    const sponsor = await Sponsor.create(pickSponsorFields(req.body || {}));
    res.status(201).json({ success: true, data: sponsor });
  } catch (error) { next(error); }
}

export async function updateSponsor(req, res, next) {
  try {
    await requireAdmin(req);
    const sponsor = await Sponsor.findByIdAndUpdate(req.params.id, { $set: pickSponsorFields(req.body || {}) }, { new: true, runValidators: true }).lean().exec();
    if (!sponsor) throw createError(404, "Sponsor not found");
    res.json({ success: true, data: sponsor });
  } catch (error) { next(error); }
}

export async function deleteSponsor(req, res, next) {
  try {
    await requireAdmin(req);
    const sponsor = await Sponsor.findByIdAndDelete(req.params.id).lean().exec();
    if (!sponsor) throw createError(404, "Sponsor not found");
    res.json({ success: true, message: "Sponsor removed" });
  } catch (error) { next(error); }
}

export async function submitSponsorApplication(req, res, next) {
  try {
    const { name, email, company, phone, message } = req.body || {};
    if (!name?.trim() || !email?.trim() || !message?.trim()) throw createError(400, "Name, email, and message are required");
    const application = await SponsorApplication.create({ name, email, company, phone, message });
    res.status(201).json({ success: true, data: { id: application._id, status: application.status } });
  } catch (error) { next(error); }
}

export async function listSponsorApplications(req, res, next) {
  try {
    await requireAdmin(req);
    const applications = await SponsorApplication.find().sort({ createdAt: -1 }).lean().exec();
    res.json({ success: true, data: applications });
  } catch (error) { next(error); }
}

export async function updateSponsorApplication(req, res, next) {
  try {
    await requireAdmin(req);
    const application = await SponsorApplication.findByIdAndUpdate(req.params.id, { $set: { status: req.body?.status } }, { new: true, runValidators: true }).lean().exec();
    if (!application) throw createError(404, "Application not found");
    res.json({ success: true, data: application });
  } catch (error) { next(error); }
}
