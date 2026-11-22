import mongoose from "mongoose";

const sponsorSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  website: { type: String, required: true, trim: true },
  logo: { type: String, default: "" },
  tagline: { type: String, default: "" },
  description: { type: String, default: "" },
  media: [{
    type: { type: String, enum: ["image", "video"], required: true },
    url: { type: String, required: true, trim: true },
    caption: { type: String, default: "" },
    alt: { type: String, default: "" },
    poster: { type: String, default: "" },
  }],
  placement: { type: String, enum: ["featured", "partner", "community"], default: "partner" },
  active: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
}, { timestamps: true });

export default mongoose.models.Sponsor || mongoose.model("Sponsor", sponsorSchema);
