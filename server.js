const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));
app.get("/health", (_, res) => res.json({ ok: true, game: "NOVA FOOTBALL ONLINE V3" }));

const rooms = new Map();

function code() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function makeRoom() {
  let id = code();
  while (rooms.has(id)) id = code();

  const room = {
    id,
    players: [],
    started: false,
    score: [0, 0],
    ball: { x: 0, z: 0, vx: 0, vz: 0, owner: null },
    goalFlash: 0
  };
  rooms.set(id, room);
  return room;
}

function addPlayer(room, socket) {
  if (room.players.length >= 2) return false;

  const team = room.players.length;
  room.players.push({
    id: socket.id,
    team,
    x: team === 0 ? -5 : 5,
    z: 0,
    dx: 0,
    dz: 0,
    ready: false,
    input: { x: 0, z: 0 },
    lastAction: 0
  });

  socket.join(room.id);
  socket.data.room = room.id;
  socket.emit("joined", {
    room: room.id,
    team,
    waiting: room.players.length < 2
  });
  sendState(room);
  return true;
}

function sendState(room) {
  io.to(room.id).emit("state", {
    room: room.id,
    started: room.started,
    score: room.score,
    ball: room.ball,
    players: room.players.map(p => ({
      id: p.id,
      team: p.team,
      x: p.x,
      z: p.z,
      ready: p.ready
    }))
  });
}

function removeFromRoom(socket) {
  const id = socket.data.room;
  if (!id) return;
  const room = rooms.get(id);
  if (!room) return;

  room.players = room.players.filter(p => p.id !== socket.id);
  if (room.players.length === 0) {
    rooms.delete(id);
  } else {
    room.started = false;
    room.ball.owner = null;
    room.ball.x = 0;
    room.ball.z = 0;
    room.ball.vx = 0;
    room.ball.vz = 0;
    room.players.forEach(p => {
      p.ready = false;
      p.input = { x: 0, z: 0 };
    });
    io.to(id).emit("notice", "Rakip ayrıldı. Yeni oyuncu bekleniyor.");
    sendState(room);
  }
  socket.data.room = null;
}

io.on("connection", socket => {
  socket.on("createRoom", () => {
    removeFromRoom(socket);
    const room = makeRoom();
    addPlayer(room, socket);
  });

  socket.on("quickPlay", () => {
    removeFromRoom(socket);
    let room = [...rooms.values()].find(r => r.players.length === 1 && !r.started);
    if (!room) room = makeRoom();
    addPlayer(room, socket);
  });

  socket.on("joinRoom", raw => {
    removeFromRoom(socket);
    const id = String(raw || "").replace(/\D/g, "").slice(0, 6);
    const room = rooms.get(id);

    if (!room) {
      socket.emit("errorMessage", "Bu oda bulunamadı. Oda kodunu kontrol et veya hızlı eşleşmeyi kullan.");
      return;
    }
    if (room.players.length >= 2 || room.started) {
      socket.emit("errorMessage", "Bu oda dolu veya oyun başlamış.");
      return;
    }
    addPlayer(room, socket);
  });

  socket.on("ready", () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.ready = true;

    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      room.started = true;
      room.ball.owner = null;
      room.ball.x = 0;
      room.ball.z = 0;
      room.ball.vx = 0;
      room.ball.vz = 0;
      io.to(room.id).emit("notice", "MAÇ BAŞLADI!");
    } else {
      socket.emit("notice", "Hazırsın. Rakibin de hazır olunca maç başlayacak.");
    }
    sendState(room);
  });

  socket.on("input", data => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.started) return;
    const p = room.players.find(v => v.id === socket.id);
    if (!p) return;

    let x = Number(data?.x) || 0;
    let z = Number(data?.z) || 0;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }

    p.input = { x, z };
  });

  socket.on("action", type => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.started) return;
    const p = room.players.find(v => v.id === socket.id);
    if (!p) return;

    const now = Date.now();
    if (now - p.lastAction < 300) return;
    p.lastAction = now;

    const b = room.ball;
    const distance = Math.hypot(p.x - b.x, p.z - b.z);

    if (type === "shoot" && b.owner === p.id) {
      b.owner = null;
      const direction = p.team === 0 ? 1 : -1;
      b.vx = direction * 0.85;
      b.vz = (Math.random() - 0.5) * 0.22;
      b.x = p.x + direction * 0.9;
      b.z = p.z;
    }

    if (type === "press" && b.owner && b.owner !== p.id && distance < 2.3) {
      const opponent = room.players.find(v => v.id === b.owner);
      if (opponent && Math.hypot(p.x - opponent.x, p.z - opponent.z) < 2.5) {
        b.owner = p.id;
        b.vx = 0;
        b.vz = 0;
      }
    }
  });

  socket.on("disconnect", () => removeFromRoom(socket));
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.started) continue;

    const b = room.ball;

    for (const p of room.players) {
      const input = p.input || { x: 0, z: 0 };
      p.x += input.x * 0.17;
      p.z += input.z * 0.17;
      p.x = Math.max(-19, Math.min(19, p.x));
      p.z = Math.max(-9, Math.min(9, p.z));
    }

    if (b.owner) {
      const owner = room.players.find(p => p.id === b.owner);
      if (owner) {
        const direction = owner.team === 0 ? 1 : -1;
        b.x = owner.x + direction * 0.8;
        b.z = owner.z;
        b.vx = 0;
        b.vz = 0;
      } else {
        b.owner = null;
      }
    } else {
      b.x += b.vx;
      b.z += b.vz;
      b.vx *= 0.985;
      b.vz *= 0.985;

      if (Math.abs(b.z) > 9) {
        b.z = Math.sign(b.z) * 9;
        b.vz *= -0.65;
      }

      if (Math.abs(b.vx) + Math.abs(b.vz) < 0.025) {
        b.vx = 0;
        b.vz = 0;
      }

      if (Math.abs(b.x) > 19 && Math.abs(b.z) < 3.2) {
        if (b.x > 0) room.score[0]++;
        else room.score[1]++;

        io.to(room.id).emit("notice", "GOOOL!");
        b.x = 0; b.z = 0; b.vx = 0; b.vz = 0; b.owner = null;

        room.players.forEach(p => {
          p.x = p.team === 0 ? -5 : 5;
          p.z = 0;
          p.input = { x: 0, z: 0 };
        });
      } else {
        for (const p of room.players) {
          if (Math.hypot(p.x - b.x, p.z - b.z) < 1.25) {
            b.owner = p.id;
            b.vx = 0;
            b.vz = 0;
            break;
          }
        }
      }
    }
    sendState(room);
  }
}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("NOVA FOOTBALL ONLINE V3 aktif: " + PORT);
});
