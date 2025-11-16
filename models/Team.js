import mongoose from "mongoose"


const teamSchema = new mongoose.Schema({
  name: { type: String, required: true },
  logo:{type: String, required: true},
  coach: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach' },
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],
  matchesPlayed: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  draws: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  goalsFor: { type: Number, default: 0 },
  goalsAgainst: { type: Number, default: 0 },
  competitionId:{type: mongoose.Schema.Types.ObjectId, ref:'Competition'},
  points: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Team', teamSchema);
