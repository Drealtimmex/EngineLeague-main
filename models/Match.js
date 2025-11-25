// models/Match.js
import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Goal schema:
 *  - minute: Number | null
 *  - team: ObjectId -> beneficiary team (who gets the goal in scoreboard)
 *  - scorer: ObjectId | null (null for own goals)
 *  - assist: ObjectId | null
 *  - ownGoal: Boolean
 *  - ownBy: ObjectId | null (player who put ball into their own net)
 */
const GoalSchema = new Schema({
  minute: { type: Number, default: null },
  team: { type: Schema.Types.ObjectId, ref: "Team", required: false },
  scorer: { type: Schema.Types.ObjectId, ref: "Player", required: false, default: null },
  assist: { type: Schema.Types.ObjectId, ref: "Player", required: false, default: null },
  ownGoal: { type: Boolean, default: false },
  ownBy: { type: Schema.Types.ObjectId, ref: "Player", required: false, default: null },
});

/**
 * Card schema
 */
const CardSchema = new Schema({
  minute: { type: Number, default: null },
  team: { type: Schema.Types.ObjectId, ref: "Team", required: false },
  player: { type: Schema.Types.ObjectId, ref: "Player", required: false },
  type: { type: String, enum: ["Yellow", "Red"], required: true },
});

/**
 * Substitution schema
 */
const SubSchema = new Schema({
  minute: { type: Number, default: null },
  team: { type: Schema.Types.ObjectId, ref: "Team", required: false },
  playerIn: { type: Schema.Types.ObjectId, ref: "Player", required: false },
  playerOut: { type: Schema.Types.ObjectId, ref: "Player", required: false },
});

/**
 * Timeline ref (simple reference)
 */
const TimelineRefSchema = new Schema({
  type: Schema.Types.ObjectId,
  ref: { type: String },
});

/**
 * Match schema
 */
const MatchSchema = new Schema(
  {
    homeTeam: { type: Schema.Types.ObjectId, ref: "Team", required: true },
    awayTeam: { type: Schema.Types.ObjectId, ref: "Team", required: true },

    date: { type: Date, required: false }, // kick-off date/time
    venue: { type: String, required: false },

    lineups: {
      home: [{ type: Schema.Types.ObjectId, ref: "Player" }],
      away: [{ type: Schema.Types.ObjectId, ref: "Player" }],
    },
    bench: {
      home: [{ type: Schema.Types.ObjectId, ref: "Player" }],
      away: [{ type: Schema.Types.ObjectId, ref: "Player" }],
    },

    goals: [GoalSchema],
    substitutions: [SubSchema],
    cards: [CardSchema],

    homeScore: { type: Number, default: 0 },
    awayScore: { type: Number, default: 0 },

    result: { type: String, default: null }, // optional text result "2-1"
    fulltime: { type: Boolean, default: false },

    matchRatings: [
      {
        player: { type: Schema.Types.ObjectId, ref: "Player" },
        rating: { type: Number },
      },
    ],
     gameweek: { type: Number, default: null },

  // NEW: mark if fantasy points for this match were computed
  fantasyProcessed: { type: Boolean, default: false },

  // NEW: store per-team points for this match (teamId -> points)
  // Using a Map of Numbers; will be stored as an object in Mongo
  fantasyTeamPoints: { type: Map, of: Number, default: {} },
    manOftheMatch: { type: Schema.Types.ObjectId, ref: "Player", required: false },

    // timeline docs are separate model; we store references
    timeline: [{ type: Schema.Types.ObjectId, ref: "Timeline" }],

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

/**
 * Utility to safely compare ids (works with ObjectId, string, or mixed)
 */
function idEquals(a, b) {
  if (!a || !b) return false;
  // If it's an object with _id, use that
  const norm = (x) => {
    if (typeof x === "object" && x._id) return String(x._id);
    return String(x);
  };
  try {
    return norm(a) === norm(b);
  } catch (e) {
    return false;
  }
}

/**
 * Method to recompute scores from goals array (beneficiary team stored in goal.team)
 * This will set homeScore, awayScore and result.
 */
MatchSchema.methods.recomputeScoresFromGoals = function () {
  // if home/away missing, zero scores
  if (!this.homeTeam || !this.awayTeam) {
    this.homeScore = 0;
    this.awayScore = 0;
    this.result = `${this.homeScore}-${this.awayScore}`;
    return;
  }

  let homeScore = 0;
  let awayScore = 0;

  const homeId = this.homeTeam;
  const awayId = this.awayTeam;

  if (Array.isArray(this.goals)) {
    for (const g of this.goals) {
      if (!g || !g.team) continue;
      if (idEquals(g.team, homeId)) homeScore += 1;
      else if (idEquals(g.team, awayId)) awayScore += 1;
      // else ignore goals that don't belong to either side
    }
  }

  this.homeScore = homeScore;
  this.awayScore = awayScore;
  this.result = `${homeScore}-${awayScore}`;
};

/**
 * Pre-save hook to ensure homeScore/awayScore/result are always correct
 * whenever the document is saved.
 */
MatchSchema.pre("save", function (next) {
  try {
    // recompute based on goals array
    this.recomputeScoresFromGoals();
  } catch (err) {
    // don't crash save on hook error, just log and continue
    // (but you can also pass error to next(err) to abort save)
    // eslint-disable-next-line no-console
    console.warn("Error in Match pre-save recomputeScoresFromGoals:", err);
  }
  next();
});

/**
 * Virtual: computedResult returns a "home-away" string from stored homeScore/awayScore
 */
MatchSchema.virtual("computedResult").get(function () {
  return `${this.homeScore ?? 0}-${this.awayScore ?? 0}`;
});

export default mongoose.models.Match || mongoose.model("Match", MatchSchema);
