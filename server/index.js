const { Server } = require("socket.io");
const http = require("http");

// Render assigns its own port dynamically via process.env.PORT
const PORT = process.env.PORT || 3001;

const server = http.createServer();
const io = new Server(server, {
  cors: {
    origin: "*", // Allows connections from your Vercel frontend
    methods: ["GET", "POST"],
  },
});

const queue = [];

io.on("connection", (socket) => {
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

// Explicitly bind to '0.0.0.0' so Render's internal proxy can detect it
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Quack signaling server running on port ${PORT}`);
});