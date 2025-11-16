// models/Player.js
import mongoose from "mongoose";

const fantasyStatSchema = new mongoose.Schema(
  {
    match: { type: mongoose.Schema.Types.ObjectId, ref: "Match", required: true },
    gameweek: { type: Number, default: null }, // nullable if gameweek unknown
    points: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const matchPerfSchema = new mongoose.Schema({
  match: { type: mongoose.Schema.Types.ObjectId, ref: "Match" },
  goals: { type: Number, default: 0 },
  assists: { type: Number, default: 0 },
  yellowCards: { type: Number, default: 0 },
  redCard: { type: Boolean, default: false },
  manOfTheMatch: { type: Boolean, default: false }
}, { _id: false });

const playerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  team: { type: mongoose.Schema.Types.ObjectId, ref: "Team" },
  position: { type: String, enum:['CB','LB','RB','CM','DM','ST','CF','LW','RW','GK','AM'], required: true },
  playerPic: { type: String },
  preferredFoot: { type: String, enum: ['Left','Right'] },
  goals: { type: Number, default: 0 },
  assists: { type: Number, default: 0 },
  totalyellowCards: { type: Number, default: 0 },
  totalredCards: { type: Number, default: 0 },
  matchRatings: [
    {
      match: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
      rating: { type: Number }
    }
  ],
  price: { type: Number, default: 7, min: 7, max: 12 },

  matchPerformances: { type: [matchPerfSchema], default: [] },

  // NEW: fantasy-related fields
  fantasyStats: { type: [fantasyStatSchema], default: [] }, // per-match/gameweek points for the player
  totalFantasyPoints: { type: Number, default: 0 }, // running total across season

  matchBan: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Player', playerSchema);
