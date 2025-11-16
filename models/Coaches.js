import mongoose from "mongoose"


const coachSchema = new mongoose.Schema({
  name: { type: String, required: true },
  pic:{ type: String, required: true },
  team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
  experience: { type: String }, // e.g., '10 years'
  createdAt: { type: Date, default: Date.now },
  assistant:{name:{type:String},
pic:{type: String }}
});

export default mongoose.model('Coach', coachSchema);
