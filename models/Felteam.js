// models/FantasyTeam.js
import mongoose from "mongoose";

const playerEntrySchema = new mongoose.Schema(
  {
    player: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true },
    isStarting: { type: Boolean, required: true, default: false },
    playerPrice: { type: Number, required: true }, // price locked at signing time
    position: { type: String }, // original position string (e.g. "CB","CM","ST")
    team: { type: mongoose.Schema.Types.ObjectId, ref: "Team" }, // cached real team id
  },
  { _id: false }
);

const transfersSchema = new mongoose.Schema(
  {
    lastResetGw: { type: Number, default: null },
    freeTransfersUsedInGw: { type: Number, default: 0 },
  },
  { _id: false }
);

const fantasyTeamSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  teamName: { type: String, required: true },
  teamLogo: { type: String },
  players: { type: [playerEntrySchema], default: [] }, // 15 entries
  budget: { type: Number, default: 150 },
  points: { type: Number, default: 0 },
  competitionId: { type: mongoose.Schema.Types.ObjectId, ref: "Competition", default: null },

  // line-up and captain info
  captain: { type: mongoose.Schema.Types.ObjectId, ref: "Player", default: null },
  viceCaptain: { type: mongoose.Schema.Types.ObjectId, ref: "Player", default: null },

  // the earliest gameweek number the team takes effect from
  effectiveGameweek: { type: Number, default: null },

  // transfers meta for free-transfer accounting
  transfers: { type: transfersSchema, default: () => ({}) },

  // store per-gameweek points breakdown (object map: gwNumber -> points)
  gameweekPoints: { type: Map, of: Number, default: {} },

  // track when lineup was last set — useful for checking "edit started but not completed"
  lastLineupSetAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
});

fantasyTeamSchema.index({ user: 1, competitionId: 1 });

export default mongoose.model("FantasyTeam", fantasyTeamSchema);
