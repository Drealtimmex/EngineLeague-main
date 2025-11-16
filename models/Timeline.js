import mongoose from "mongoose"


const timelineSchema = new mongoose.Schema({
  title: { type: String},
 description:{ type: String},
  images: [{ type:String }],
  match:{ type: mongoose.Schema.Types.ObjectId, ref: 'Match'},
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Timeline', timelineSchema);
