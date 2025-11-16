import nodemailer from 'nodemailer';
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

export const sendPaymentNotification = async (email, amount, name) => {
    const user = await User.findOne({ email });
    if (!user) throw new Error('User not found');
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Payment Received',
        text: `Hello ${name},\n\nYou have successfully received a payment of ${amount} kobo for your order.You shall be credited once you complete service.\n\nThank you for using our service!`
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.log('Error sending email:', error);
        } else {
            console.log('Email sent: ' + info.response);
        }
    });
};