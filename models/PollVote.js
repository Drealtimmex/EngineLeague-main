import mongoose from "mongoose";

const pollVoteSchema = new mongoose.Schema({
  poll: { type: mongoose.Schema.Types.ObjectId, ref: "Poll", required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  option: { type: mongoose.Schema.Types.ObjectId, required: true },
}, { timestamps: true });
pollVoteSchema.index({ poll: 1, user: 1 }, { unique: true });

export default mongoose.models.PollVote || mongoose.model("PollVote", pollVoteSchema);
