import mongoose from "mongoose";

const sponsorApplicationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  company: { type: String, default: "", trim: true },
  phone: { type: String, default: "", trim: true },
  message: { type: String, required: true, trim: true },
  status: { type: String, enum: ["new", "reviewing", "approved", "declined"], default: "new" },
}, { timestamps: true });

export default mongoose.models.SponsorApplication || mongoose.model("SponsorApplication", sponsorApplicationSchema);
