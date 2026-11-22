import mongoose from "mongoose";

const optionSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true, maxlength: 120 },
}, { _id: true });

const pollSchema = new mongoose.Schema({
  question: { type: String, required: true, trim: true, maxlength: 240 },
  description: { type: String, default: "", maxlength: 1200 },
  options: { type: [optionSchema], validate: (items) => items.length >= 2 && items.length <= 100 },
  resultsVisibility: { type: String, enum: ["live", "after-vote", "after-close", "hidden"], default: "live" },
  opensAt: { type: Date, default: Date.now },
  closesAt: { type: Date, default: null },
  active: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });

export default mongoose.models.Poll || mongoose.model("Poll", pollSchema);
