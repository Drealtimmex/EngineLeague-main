import mongoose from "mongoose";

const mediaSchema = new mongoose.Schema({
  type: { type: String, enum: ["image", "video", "embed"], required: true },
  url: { type: String, required: true, trim: true },
  caption: { type: String, default: "", trim: true },
}, { _id: false });

const articleSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 180 },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  excerpt: { type: String, default: "", maxlength: 400 },
  body: { type: String, required: true, maxlength: 30000 },
  coverImage: { type: String, default: "" },
  media: { type: [mediaSchema], default: [] },
  poll: { type: mongoose.Schema.Types.ObjectId, ref: "Poll", default: null },
  status: { type: String, enum: ["draft", "published"], default: "draft" },
  publishedAt: { type: Date, default: null },
  author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });

export default mongoose.models.Article || mongoose.model("Article", articleSchema);
