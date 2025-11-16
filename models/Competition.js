import mongoose from "mongoose"


const competitionSchema = new mongoose.Schema({
  name: { type: String, required: true },
 logo:{ type: String},
  teams: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }],
  winner:{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
  
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Competition', competitionSchema);
