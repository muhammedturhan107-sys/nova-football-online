const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

const rooms = new Map();

function newRoom() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));

  return {
    code,
    players: new Map(),
    ball: { x: 0, z: 0, vx: 0, vz: 0 },
    score: [0, 0],
    started: false,
    endAt: 0
  };
}

function roomState(room) {
  return {
    players: [...room.players.values()].map(p => ({
      id: p.id,
      team: p.team,
      x: p.x,
      z: p.z,
      yaw: p.yaw
    })),
    ball: room.ball,
    score: room.score,
    started: room.started,
    time: room.started
      ? Math.max(0, Math.ceil((room.endAt - Date.now()) / 1000))
      : 90
  };
}

io.on("connection", socket => {
  socket.on("createRoom", name => {
    const room = newRoom();
    rooms.set(room.code, room);
    joinRoom(socket, room, name);
  });

  socket.on("joinRoom", data => {
    const code = String(data?.code || "").trim();
    const room = rooms.get(code);

    if (!room) {
      socket.emit("errorMessage", "Bu oda bulunamadı.");
      return;
    }

    if (room.players.size >= 2) {
      socket.emit("errorMessage", "Oda dolu.");
      return;
    }

    joinRoom(socket, room, data.name);
  });

  function joinRoom(socket, room, name) {
    const player = {
      id: socket.id,
      name: String(name || "Oyuncu").slice(0, 16),
      team: room.players.size,
      x: room.players.size === 0 ? -5 : 5,
      z: 0,
      yaw: 0,
      input: { x: 0, z: 0 },
      kick: false
    };

    room.players.set(socket.id, player);
    socket.join(room.code);
    socket.data.room = room.code;

    socket.emit("joined", {
      code: room.code,
      id: socket.id,
      team: player.team,
      opponent: room.players.size === 2
    });

    if (room.players.size === 2) {
      room.started = true;
      room.endAt = Date.now() + 90000;
      io.to(room.code).emit("matchStarted");
    }

    io.to(room.code).emit("state", roomState(room));
  }

  socket.on("input", data => {
    const room = rooms.get(socket.data.room);
    const p = room?.players.get(socket.id);
    if (!p || !room.started) return;

    p.input.x = Math.max(-1, Math.min(1, Number(data.x) || 0));
    p.input.z = Math.max(-1, Math.min(1, Number(data.z) || 0));
    p.kick = !!data.kick;
  });

  socket.on("disconnect", () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return;

    room.players.delete(socket.id);
    io.to(code).emit("opponentLeft");

    if (room.players.size === 0) rooms.delete(code);
    else {
      room.started = false;
      io.to(code).emit("state", roomState(room));
    }
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.started) continue;

    for (const p of room.players.values()) {
      const speed = 0.13;
      p.x += p.input.x * speed;
      p.z += p.input.z * speed;

      p.x = Math.max(-13, Math.min(13, p.x));
      p.z = Math.max(-8, Math.min(8, p.z));

      if (Math.abs(p.input.x) + Math.abs(p.input.z) > 0.01) {
        p.yaw = Math.atan2(p.input.x, p.input.z);
      }

      const b = room.ball;
      const dx = b.x - p.x;
      const dz = b.z - p.z;

      if (p.kick && Math.hypot(dx, dz) < 2.1) {
        const len = Math.hypot(dx, dz) || 1;
        b.vx = dx / len * 0.55;
        b.vz = dz / len * 0.55;
      }
      p.kick = false;
    }

    const b = room.ball;
    b.x += b.vx;
    b.z += b.vz;
    b.vx *= 0.985;
    b.vz *= 0.985;

    if (Math.abs(b.z) > 9) {
      b.z = Math.sign(b.z) * 9;
      b.vz *= -0.7;
    }

    if (Math.abs(b.x) > 15) {
      if (Math.abs(b.z) < 3) {
        room.score[b.x > 0 ? 0 : 1]++;
        b.x = 0;
        b.z = 0;
        b.vx = b.vz = 0;
      } else {
        b.x = Math.sign(b.x) * 15;
        b.vx *= -0.7;
      }
    }

    if (Date.now() >= room.endAt) {
      room.started = false;
      io.to(room.code).emit("matchEnded", {
        score: room.score
      });
    }

    io.to(room.code).emit("state", roomState(room));
  }
}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("NOVA FOOTBALL ONLINE aktif: " + PORT);
});
