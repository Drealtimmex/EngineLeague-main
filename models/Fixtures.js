import mongoose from "mongoose"

const fixtureSchema = new mongoose.Schema({
  gameweek: { type: mongoose.Schema.Types.ObjectId, ref: 'Gameweek'}, // Reference to the gameweek
  homeTeam: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: false }, // Home team reference
  awayTeam: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: false }, // Away team reference
  match: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' }, // Link to Match model
  bye: { type: Boolean, default: false }, // Indicates if this is a bye week for a team
   competitionId:{type: mongoose.Schema.Types.ObjectId, ref: 'Competition'},
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Fixture', fixtureSchema);
