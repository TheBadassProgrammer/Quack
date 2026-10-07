require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const nodemailer = require("nodemailer");
const { PrismaClient } = require("@prisma/client");

const PORT = process.env.PORT || 3001;
const prisma = new PrismaClient();

const server = http.createServer();
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const queue = [];
const otpStore = {}; 
const activeUsers = new Map(); 

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "your-email@gmail.com",
    pass: process.env.EMAIL_PASS || "your-app-password",
  },
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // --- 1. USER REGISTRATION WITH ACKNOWLEDGMENT ---
  socket.on("register_user", async ({ email, domain }, callback) => {
    try {
      let user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        user = await prisma.user.create({ data: { email, domain } });
        console.log("New user registered:", user.email);
      } else {
        console.log("User logged in:", user.email);
      }

      activeUsers.set(user.id, socket.id);
      
      if (typeof callback === "function") {
        callback({ userId: user.id });
      }
    } catch (error) {
      console.error("Database registration error:", error);
      if (typeof callback === "function") {
        callback({ error: error.message });
      }
    }
  });

  // --- 2. AUTHENTICATION & OTP ---
  socket.on("request_otp", async ({ email, mode }) => {
    const domain = email.split("@")[1];
    
    if (mode === "college" && (!domain || (!domain.endsWith(".edu") && !domain.endsWith(".ac.in")))) {
      socket.emit("otp_error", { error: "Please use a valid college email (.edu or .ac.in)" });
      return;
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = { code, expiresAt: Date.now() + 5 * 60 * 1000, mode };

    try {
      await transporter.sendMail({
        from: '"Quack App" <no-reply@quack.com>',
        to: email,
        subject: "Your Quack Login Code",
        text: `Your verification code is: ${code}`,
      });
      socket.emit("otp_sent", { success: true });
    } catch (error) {
      console.error("Email error (printing code to console instead):", code);
      socket.emit("otp_sent", { success: true });
    }
  });

  socket.on("verify_otp", ({ email, code }) => {
    const record = otpStore[email];
    if (record && record.code === code && record.expiresAt > Date.now()) {
      delete otpStore[email];
      const domain = email.split("@")[1];
      socket.emit("otp_verified", { success: true, domain });
    } else {
      socket.emit("otp_verified", { success: false, error: "Invalid or expired code." });
    }
  });

  // --- 3. FRIENDSHIPS & DIRECT MESSAGES ---
  socket.on("add_friend", async ({ myId, peerId }) => {
    if (!myId || !peerId || myId === peerId) return;

    try {
      const [userAId, userBId] = [myId, peerId].sort();

      const existing = await prisma.friendship.findUnique({
        where: { userAId_userBId: { userAId, userBId } },
      });

      if (!existing) {
        await prisma.friendship.create({ data: { userAId, userBId } });
        console.log(`Friendship formed between ${userAId} and ${userBId}`);
      }
    } catch (error) {
      console.error("Friendship database error:", error);
    }
  });

  socket.on("fetch_friends", async ({ userId }) => {
    try {
      const friendships = await prisma.friendship.findMany({
        where: {
          OR: [{ userAId: userId }, { userBId: userId }],
        },
        include: { userA: true, userB: true },
      });

      const friends = friendships.map((f) => (f.userAId === userId ? f.userB : f.userA));
      socket.emit("friends_list", friends);
    } catch (error) {
      console.error("Fetch friends database error:", error);
    }
  });

  socket.on("fetch_messages", async ({ userId, peerId }) => {
    try {
      const messages = await prisma.message.findMany({
        where: {
          OR: [
            { senderId: userId, receiverId: peerId },
            { senderId: peerId, receiverId: userId }
          ]
        },
        orderBy: { createdAt: "asc" }
      });
      socket.emit("message_history", messages);
    } catch (error) {
      console.error("Fetch messages error:", error);
    }
  });

  socket.on("send_dm", async ({ senderId, receiverId, text }) => {
    try {
      const message = await prisma.message.create({
        data: { senderId, receiverId, text },
      });

      const receiverSocketId = activeUsers.get(receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("receive_dm", message);
      }
      // Also echo back to sender socket so UI updates instantly
      socket.emit("receive_dm", message);
    } catch (error) {
      console.error("Send DM database error:", error);
    }
  });

  // --- 4. MATCHMAKING & WEBRTC ---
  socket.on("join_queue", ({ domain }) => {
    const existingIdx = queue.findIndex((u) => u.socketId === socket.id);
    if (existingIdx !== -1) queue.splice(existingIdx, 1);

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

  // --- 5. DISCONNECT CLEANUP ---
  socket.on("disconnect", () => {
    const idx = queue.findIndex((u) => u.socketId === socket.id);
    if (idx !== -1) queue.splice(idx, 1);

    for (let [userId, socketId] of activeUsers.entries()) {
      if (socketId === socket.id) {
        activeUsers.delete(userId);
        break;
      }
    }
    console.log("User disconnected:", socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Quack server on port ${PORT}`));