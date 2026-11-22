import mongoose from "mongoose";

const announcementSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 140 },
  message: { type: String, required: true, trim: true, maxlength: 1200 },
  type: { type: String, enum: ["general", "goal", "postponement", "competition", "poll"], default: "general" },
  href: { type: String, default: "" },
  startsAt: { type: Date, default: Date.now },
  endsAt: { type: Date, default: null },
  active: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });

export default mongoose.models.Announcement || mongoose.model("Announcement", announcementSchema);
