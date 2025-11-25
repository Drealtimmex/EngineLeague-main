// models/FantasyTeam.js
import mongoose from "mongoose";

const playerEntrySchema = new mongoose.Schema(
  {
    player: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true },
    isStarting: { type: Boolean, required: true, default: false }, // current/active lineup flag
    playerPrice: { type: Number, required: true },
    position: { type: String },
    team: { type: mongoose.Schema.Types.ObjectId, ref: "Team" },
  },
  { _id: false }
);

const lineupSnapshotSchema = new mongoose.Schema(
  {
    starting: [{ type: mongoose.Schema.Types.ObjectId, ref: "Player" }], // 11 ids
    captain: { type: mongoose.Schema.Types.ObjectId, ref: "Player", default: null },
    viceCaptain: { type: mongoose.Schema.Types.ObjectId, ref: "Player", default: null },
    setAt: { type: Date, default: Date.now },
    // optional: whether this snapshot is intended to be the durable default lineup
    isDefault: { type: Boolean, default: false },
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
  players: { type: [playerEntrySchema], default: [] }, // roster (15)
  budget: { type: Number, default: 150 },
  points: { type: Number, default: 0 },
  competitionId: { type: mongoose.Schema.Types.ObjectId, ref: "Competition", default: null },

  captain: { type: mongoose.Schema.Types.ObjectId, ref: "Player", default: null },
  viceCaptain: { type: mongoose.Schema.Types.ObjectId, ref: "Player", default: null },

  effectiveGameweek: { type: Number, default: null },

  transfers: { type: transfersSchema, default: () => ({}) },

  // store per-gameweek points breakdown (Map: "1" -> Number)
  gameweekPoints: { type: Map, of: Number, default: {} },

  // store per-match points (helpful): matchId -> { points, gameweek }
  matchPoints: { type: Map, of: Object, default: {} },

  // store lineup snapshots:
  // key: "default" or gameweek number as string e.g. "1", "2", ...
  lineupSnapshots: { type: Map, of: lineupSnapshotSchema, default: {} },

  // track when lineup was last set — useful for UI & TTL
  lastLineupSetAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
});

fantasyTeamSchema.index({ user: 1, competitionId: 1 });

export default mongoose.models.FantasyTeam || mongoose.model("FantasyTeam", fantasyTeamSchema);
