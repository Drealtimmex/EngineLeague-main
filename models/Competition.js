import mongoose from "mongoose"


const competitionSchema = new mongoose.Schema({
  name: { type: String, required: true },
 logo:{ type: String},
  teams: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }],
  winner:{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
  // Each Competition document represents one season. Keeping the active flag
  // here lets clients start a fresh season without reusing old GW numbers.
  isActive: { type: Boolean, default: false, index: true },
  season: { type: String, default: null },
  
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Competition', competitionSchema);
