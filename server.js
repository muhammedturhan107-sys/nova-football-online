const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

const rooms = new Map();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function newRoom() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));

  return {
    code,
    players: new Map(),
    ball: { x: 0, z: 0, vx: 0, vz: 0 },
    owner: null,
    score: [0, 0],
    started: false,
    goalPause: 0
  };
}

function state(room) {
  return {
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      x: p.x,
      z: p.z,
      yaw: p.yaw,
      pressing: p.press
    })),
    ball: room.ball,
    owner: room.owner,
    score: room.score,
    started: room.started,
    time: "∞"
  };
}

function broadcast(room) {
  io.to(room.code).emit("state", state(room));
}

function joinRoom(socket, room, name) {
  if (room.players.size >= 2) {
    socket.emit("errorMessage", "Oda dolu.");
    return;
  }

  const team = room.players.size;
  const player = {
    id: socket.id,
    name: String(name || "Oyuncu").slice(0, 16),
    team,
    x: team === 0 ? -5 : 5,
    z: 0,
    yaw: team === 0 ? Math.PI / 2 : -Math.PI / 2,
    input: { x: 0, z: 0 },
    kick: false,
    press: false,
    lastAction: 0
  };

  room.players.set(socket.id, player);
  socket.join(room.code);
  socket.data.room = room.code;

  socket.emit("joined", {
    code: room.code,
    id: socket.id,
    team
  });

  if (room.players.size === 2) {
    room.started = true;
    io.to(room.code).emit("matchStarted");
  }

  broadcast(room);
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

    joinRoom(socket, room, data?.name);
  });

  socket.on("input", data => {
    const room = rooms.get(socket.data.room);
    const p = room?.players.get(socket.id);

    if (!p || !room.started) return;

    p.input.x = clamp(Number(data?.x) || 0, -1, 1);
    p.input.z = clamp(Number(data?.z) || 0, -1, 1);
    p.kick = !!data?.kick;
    p.press = !!data?.press;
  });

  socket.on("disconnect", () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return;

    room.players.delete(socket.id);

    if (room.owner === socket.id) room.owner = null;

    room.started = false;
    io.to(code).emit("opponentLeft");

    if (room.players.size === 0) {
      rooms.delete(code);
    } else {
      broadcast(room);
    }
  });
});

function resetAfterGoal(room) {
  room.ball = { x: 0, z: 0, vx: 0, vz: 0 };
  room.owner = null;
  room.goalPause = 35;

  for (const p of room.players.values()) {
    p.x = p.team === 0 ? -5 : 5;
    p.z = 0;
    p.input = { x: 0, z: 0 };
    p.kick = false;
    p.press = false;
  }
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.started || room.players.size !== 2) continue;

    if (room.goalPause > 0) {
      room.goalPause--;
      broadcast(room);
      continue;
    }

    const b = room.ball;

    for (const p of room.players.values()) {
      const speed = 0.19;
      const inputLength = Math.hypot(p.input.x, p.input.z);

      if (inputLength > 0.05) {
        const scale = Math.min(1, inputLength);
        p.x += (p.input.x / Math.max(1, inputLength)) * speed * scale;
        p.z += (p.input.z / Math.max(1, inputLength)) * speed * scale;
        p.yaw = Math.atan2(p.input.x, p.input.z);
      }

      p.x = clamp(p.x, -15.5, 15.5);
      p.z = clamp(p.z, -9.5, 9.5);

      const distance = Math.hypot(b.x - p.x, b.z - p.z);

      // Topu yakalama
      if (!room.owner && distance < 1.25 &&
          Math.hypot(b.vx, b.vz) < 0.32) {
        room.owner = p.id;
      }

      // Rakip presi: topa yakın rakip, topu kontrol eden oyuncudan alabilir.
      if (room.owner && room.owner !== p.id && p.press && distance < 1.65) {
        const owner = room.players.get(room.owner);
        if (owner && Date.now() - p.lastAction > 450) {
          room.owner = p.id;
          p.lastAction = Date.now();
          io.to(room.code).emit("notice", p.name + " TOPU KAPTI!");
        }
      }

      // Şut yalnızca topun sahibi tarafından kullanılabilir.
      if (p.kick && room.owner === p.id) {
        const attack = p.team === 0 ? 1 : -1;
        const aimX = attack;
        const aimZ = clamp(p.input.z * 0.65, -0.55, 0.55);
        const length = Math.hypot(aimX, aimZ) || 1;

        b.vx = (aimX / length) * 0.78;
        b.vz = (aimZ / length) * 0.78;
        room.owner = null;

        io.to(room.code).emit("notice", "ŞUT!");
      }

      p.kick = false;
    }

    // Top oyuncudaysa ayağının önünde ilerler.
    if (room.owner) {
      const owner = room.players.get(room.owner);

      if (owner) {
        const attack = owner.team === 0 ? 1 : -1;
        b.x = owner.x + attack * 0.9;
        b.z = owner.z + owner.input.z * 0.45;
        b.vx = 0;
        b.vz = 0;
      } else {
        room.owner = null;
      }
    } else {
      b.x += b.vx;
      b.z += b.vz;
      b.vx *= 0.985;
      b.vz *= 0.985;

      if (Math.abs(b.z) > 10) {
        b.z = clamp(b.z, -10, 10);
        b.vz *= -0.65;
      }

      if (Math.abs(b.x) > 17) {
        if (Math.abs(b.z) < 3.2) {
          const scoringTeam = b.x > 0 ? 0 : 1;
          room.score[scoringTeam]++;

          io.to(room.code).emit("goal", {
            team: scoringTeam,
            score: room.score
          });

          resetAfterGoal(room);
        } else {
          b.x = clamp(b.x, -17, 17);
          b.vx *= -0.65;
        }
      }
    }

    broadcast(room);
  }
}, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("NOVA FOOTBALL ONLINE V2 aktif: " + PORT);
});
