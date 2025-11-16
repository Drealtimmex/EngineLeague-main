import mongoose from "mongoose";

const UserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
    },
    username:{
      type:String,
      unique:true
    },
    password: {
      type: String,
      // required: true,
    },
    name:{
      type:String
    },
    number:{type:Number},
    resetPasswordTokenExpiry:{
      type:String
    },
    resetPasswordToken:{
      type:String
    },
    fromGoogle:{
      type:Boolean,
      default:false
    },
    role:{
      type:String,
      default:"user"
    },
    team:{type: mongoose.Schema.Types.ObjectId, ref: 'Team'},
    googleId: {
      type: String, // Add Google ID field
    },
    address:{type:String},
    verificationCode: { type: String },
verificationCodeExpiry: { type: Date },
profilePicture:{type:String}
  },
  
  { timestamps: true }
);


export default mongoose.model("User", UserSchema);
