// server/index.js
const { Server } = require("socket.io");
const http = require("http");

const server = http.createServer();
const io = new Server(server, {
  cors: { origin: "http://localhost:3000", methods: ["GET", "POST"] }
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

server.listen(3001, () => console.log("Quack signaling server running on port 3001"));