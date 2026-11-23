import mongoose from "mongoose"


const timelineSchema = new mongoose.Schema({
  title: { type: String},
 description:{ type: String},
  images: [{ type:String }],
  media: [{ type: { type: String, enum: ["image", "video", "embed"], default: "image" }, url: { type: String, required: true }, caption: { type: String, default: "" } }],
  highlight: { type: Boolean, default: false },
  match:{ type: mongoose.Schema.Types.ObjectId, ref: 'Match'},
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Timeline', timelineSchema);
