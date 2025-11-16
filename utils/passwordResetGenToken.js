import CryptoJS from 'crypto-js';
import nodemailer from 'nodemailer';
import User from '../models/User.js';

const resetPasswordTokenExpiry = 3600000; // 1 hour in milliseconds

// Generate a password reset token and save it in the user's document
export const generateResetPasswordToken = async (email, next) => {
    const user = await User.findOne({ email });

    // Handle the case where the email is not associated with any user

    if (!user) return next(createError(404, "User not found!"));

    const token = CryptoJS.SHA256(email + Date.now().toString()).toString();
    const tokenExpiry = Date.now() + resetPasswordTokenExpiry;

    user.resetPasswordToken = token;
    user.resetPasswordTokenExpiry = tokenExpiry;

    await user.save();

    return token;
};