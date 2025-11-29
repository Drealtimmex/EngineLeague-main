
import bcrypt from "bcryptjs/dist/bcrypt.js";
import { createError } from "../error.js";
import User from "../models/User.js";
import { generateResetPasswordToken } from "../utils/passwordResetGenToken.js";
import { sendEmail } from "../Mailing/sendEmail.js";

  


// get a single user
export const getSingleUser = async (req, res, next) => {

  const email = req.params.email
  const user = await User.findOne({email})
  if (!user) return next(createError(404, "User not found!"))
  if (user.email === email || user.role === "admin"){
    try{
     const {password, ...others} = user
     
   res
   .status(200)
   .json(others._doc)
   }catch (err){
    next(err)
    }
  }
  else {
    return next(createError(403, "You are not authorized"))
  }
};


// Existing functions...

// Get current user based on token
export const getCurrentUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return next(createError(404, "User not found!"));
    res.status(200).json(user);
  } catch (err) {
    next(err);
  }
};


// get all users
export const getAllUsers = async (req, res, next) => {
  try {
    // To check if the user is eligible to carry out the action
   
    const user = await User.findOne({ _id:req.user.id });

    if (!user) {
      return next(createError(404, "User not found!"));
    }

    if (user.role === "admin") {
      const users = await User.find().sort({ views: -1 }).exec();
      res.status(200).json(users);
    } else {
      return next(createError(403, "You're not eligible for this action"));
    }
  } catch (err) {
    next(err);
  }
}
// update
export const updateUser = async (req, res, next) => {
    const email = req.params.email
    const user = await User.findOne({email})
    if (!user) return next(createError(404, "User not found!"))
    if (user.email === email || user.role === "admin"){
      try{
       const updatedUser = await User.findByIdAndUpdate(user._id,{$set:req.body},{new:true})
     const {password, ...others} = updatedUser
     res
     .status(200)
     .json(others)
     }catch (err){
      next(err)
      }
    }
    else {
      return next(createError(403, "You are not authorized"))
    }
  };
  //update password
  export const changePassword = async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body;
      const userId = req.user.id; // Assuming you have middleware to authenticate and set req.user
  
      if (!currentPassword || !newPassword) {
        return next(createError(400, 'Current password and new password are required'));
      }
  
      const user = await User.findById(userId);
      if (!user) return next(createError(404, 'User not found'));
  
      // Verify the current password
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) return next(createError(400, 'Current password is incorrect'));
  
      // Check if the new password is the same as the old password
      const isSame = await bcrypt.compare(newPassword, user.password);
      if (isSame) return next(createError(400, 'New password cannot be the same as the old password'));
  
      // Hash the new password and update it
      const salt = bcrypt.genSaltSync(10);
      const hashedPassword = bcrypt.hashSync(newPassword, salt);
  
      user.password = hashedPassword;
      await user.save();
  
      res.status(200).json('Password updated successfully');
    } catch (err) {
      next(err);
    }
  };
  //profile
  export const updateProfilePicture = async (req, res, next) => {
    try {
        const userId = req.user.id;  // Assuming user is authenticated and req.user.id is available
        const { profilePictureUrl } = req.body; // URL from Firebase

        if (!profilePictureUrl) {
            return next(createError(400, "Profile picture URL is required"));
        }

        const user = await User.findByIdAndUpdate(
            userId,
            { profilePicture: profilePictureUrl },
            { new: true }  // Return the updated user
        );

        if (!user) {
            return next(createError(404, "User not found!"));
        }

        res.status(200).json({
            message: "Profile picture updated successfully",
            profilePicture: user.profilePicture
        });
    } catch (err) {
        next(err);
    }
};



  // delete a user
  export const deleteUser = async (req, res, next) => {
    const email = req.params.email
    const user = await User.findOne({email})
    if (!user) return next(createError(404, "User not found!"))
    if (user.email === email || user.role === "admin"){
      try{
        await User.findByIdAndDelete(user._id)
        res.status(200).json("user has been deleted")
  
      }catch (err){
        next(err)
      }
    }
  
  else {
    return next(createError(403, "You are not authorized!"))
  }
  }
  
  // Recover user password
  export const recoverPassword = async (req, res, next) => {
    const email  = req.params.email;
  
    try {
      const resetToken = await generateResetPasswordToken(email, next);
   const subject = "Reset code"
    // Handle the case where the email is not associated with any user
    if (!resetToken) return next(createError(404, "Email not found."));
      const text = `this is your reset code ${resetToken}`
      sendEmail(email,subject ,text )
    
      // sendPasswordResetEmail(email, resetToken); 
      res.status(200).json(`email=${email}&token=${resetToken}`);
  
    } catch (err) {
      next(err);
    }
  };
  ;
  // Reset User Password
  export const resetPassword = async (req, res, next) => {
    const {email,newPassword} = req.body
  
  
    const user = await User.findOne({ email }) //get user with this email
    //authenticate the email and token
    // if (!user || user.resetPasswordTokenExpiry == null || user.resetPasswordToken != token ) return next(createError(404, "User not found"))
  
  
  
 
  
    //check if token has expired
   
    
   try {
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(newPassword,salt)
  
  
    const body ={
    password:hash}
    //UPDate the user passwrd in the model
  const updatedUser = await User.findByIdAndUpdate(
    user._id,
    {$set: body},
    {new: true}// return the updated user
  )
  
  res.status(200).json("password reset successfully")
    }catch (err) {
      next(err)
    }
  };
  
  
  // Reset User Password
  export const resetPasswordreal = async (req, res, next) => {
    const {email,token,newPassword} = req.body
  
  
    const user = await User.findOne({ email }) //get user with this email
    //authenticate the email and token
    if (!user || user.resetPasswordTokenExpiry == null || user.resetPasswordToken != token ) return next(createError(404, "User not found"))
  
  
  
    const currentExpiryTime = Date.now()
  
    //check if token has expired
    if (user.resetPasswordTokenExpiry < currentExpiryTime) return next(createError(403,"Expired Tojen"))
    
   try {
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(newPassword,salt)
  
  
    const body ={
    resetPasswordToken : null,
   resetPasswordTokenExpiry : null,
    password:hash}
    //UPDate the user passwrd in the model
  const updatedUser = await User.findByIdAndUpdate(
    user._id,
    {$set: body},
    {new: true}// return the updated user
  )
  
  res.status(200).json("password reset successfully")
    }catch (err) {
      next(err)
    }
  };
  

  //get user for signin 
  // get a single user
export const getSingleUserSignin = async (req, res, next) => {

  const user = await User.findOne({ email: req.body.email})
  if (!user) return next(createError(404, "User not found!"))
  
 //if user have a password in our database 

 if (!(user.password) && user.fromGoogle) return next(createError(401, "wrong url go sign in with google!"))

 if (!req.body.password) return next(createError(400,"wrong credentials"))
  const isCorrect = await bcrypt.compare(req.body.password, user.password)    // if (!(req.body.password) || user.fromGoogle) return next(createError(401, "Password required for authentication!"))
  // if (!(req.body.password) && user.fromGoogle)
  //if a user doesnot have a password in our database but they gave us a password
  //and from google is true sign in via google
  //if password not provided but they haave a passsword in our db and from google is false
  



  if (!isCorrect) return next(createError(400, "Wrong Credentials!"))
try{
     const {password,resetPasswordToken,resetPasswordTokenExpiry, ...others} = user
     
   res
   .status(200)
   .json(others)
   }catch (err){
    next(err)
    }
  };