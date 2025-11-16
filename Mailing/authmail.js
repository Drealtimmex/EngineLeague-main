import nodemailer from 'nodemailer';
import crypto from 'crypto';
import dotenv from 'dotenv';
import User from '../models/User.js'; // Adjust the path as needed
  
dotenv.config();
// Create a transporter for nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail', // Use your email service provider
  auth: {
    user: process.env.EMAIL_USER, // Your email address
    pass: process.env.EMAIL_PASS, // Your email password or app password
  },
});

// Function to send verification code
export const sendVerificationCode = async (email) => {
  const user = await User.findOne({ email });
  if (!user) throw new Error('User not found');

  // Generate a random verification code
  const verificationCode = crypto.randomInt(100000, 999999).toString();

  // Store the verification code and expiry (e.g., 10 minutes)
  user.verificationCode = verificationCode;
  user.verificationCodeExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes expiry
  await user.save();

  // Send email
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Your Verification Code',
    text: `Your verification code is ${verificationCode}`,
  });
};
