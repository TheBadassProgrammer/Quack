// server/index.js
require("dotenv").config();
const { Server } = require("socket.io");
const http = require("http");
const nodemailer = require("nodemailer");

const PORT = process.env.PORT || 3001;
const server = http.createServer();
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// In-memory stores
const queue = [];
const otpStore = {}; // Format: { "email@college.edu": { code: "123456", expiresAt: 123456789 } }

// Email Setup: Replace with an App Password from your Gmail account
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "your-email@gmail.com",
    pass: process.env.EMAIL_PASS || "your-app-password",
  },
});

io.on("connection", (socket) => {
  // --- AUTHENTICATION & OTP ---
  socket.on("request_otp", async ({ email }) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = { code, expiresAt: Date.now() + 5 * 60 * 1000 }; // Expires in 5 mins

    try {
      await transporter.sendMail({
        from: '"Quack App" <no-reply@quack.com>',
        to: email,
        subject: "Your Quack Login Code",
        text: `Your college verification code is: ${code}`,
      });
      socket.emit("otp_sent", { success: true });
    } catch (error) {
      console.error("Email error (printing code to console instead):", code);
      // Fallback for local testing if you haven't set up Gmail yet
      socket.emit("otp_sent", { success: true }); 
    }
  });

  socket.on("verify_otp", ({ email, code }) => {
    const record = otpStore[email];
    if (record && record.code === code && record.expiresAt > Date.now()) {
      delete otpStore[email]; // Clear OTP after use
      const domain = email.split("@")[1];
      socket.emit("otp_verified", { success: true, domain });
    } else {
      socket.emit("otp_verified", { success: false, error: "Invalid or expired code." });
    }
  });

  // --- MATCHMAKING & WEBRTC ---
  socket.on("join_queue", ({ domain }) => {
    const matchIndex = queue.findIndex((u) => u.domain === domain && u.socketId !== socket.id);
    if (matchIndex !== -1) {
      const match = queue.splice(matchIndex, 1)[0];
      const roomId = `room_${socket.id}_${match.socketId}`;
      socket.join(roomId);
      io.sockets.sockets.get(match.socketId)?.join(roomId);
      socket.emit("match_found", { roomId, initiate: true });
      io.to(match.socketId).emit("match_found", { roomId, initiate: false });
    } else {
      queue.push({ socketId: socket.id, domain });
    }
  });

  socket.on("webrtc_signal", ({ roomId, signal }) => {
    socket.to(roomId).emit("webrtc_signal", signal);
  });

  socket.on("disconnect", () => {
    const idx = queue.findIndex((u) => u.socketId === socket.id);
    if (idx !== -1) queue.splice(idx, 1);
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Quack server on port ${PORT}`));