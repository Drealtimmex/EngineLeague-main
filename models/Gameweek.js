// models/Gameweek.js
import mongoose from "mongoose";

const gameweekSchema = new mongoose.Schema({
  number: { type: Number, required: true },
  deadline: { type: Date, default: null }, // Deadline for fantasy updates
  fixtures: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Fixture' }],
  competitionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Competition', default: null },
  // stage: regular (league rounds), playoffs, semifinal, final, etc.
  stage: { type: String, enum: ['regular', 'playoff', 'semifinal', 'final'], default: 'regular' },
  createdAt: { type: Date, default: Date.now },
});


// Prevent duplicate numbers per competition
gameweekSchema.index({ competitionId: 1, number: 1 }, { unique: true });

export default mongoose.model('Gameweek', gameweekSchema);
