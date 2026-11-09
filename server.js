const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"]
});

app.use(express.static("public"));
app.get("/health", (req,res) => res.json({status:"online",version:"V6"}));

const rooms = new Map();
const socketRooms = new Map();

function code() {
  let c;
  do { c = String(100000 + crypto.randomInt(900000)); }
  while (rooms.has(c));
  return c;
}

function sendError(socket, message) {
  socket.emit("errorMessage", message);
  socket.emit("notice", message);
}

function state(room) {
  return {
    code: room.code,
    started: room.started,
    score: [...room.score],
    players: room.players.map(p => ({
      id:p.id, x:p.x, z:p.z, ready:p.ready, team:p.team
    })),
    ball: {
      x:room.ball.x, y:.35, z:room.ball.z,
      owner:room.ball.owner
    }
  };
}

function broadcast(room) {
  io.to(room.code).emit("state", state(room));
}

function leaveRoom(socket) {
  const oldCode = socketRooms.get(socket.id);
  if (!oldCode) return;
  const room = rooms.get(oldCode);
  socketRooms.delete(socket.id);
  socket.leave(oldCode);
  if (!room) return;

  room.players = room.players.filter(p => p.id !== socket.id);
  room.started = false;
  room.players.forEach(p => p.ready = false);

  if (!room.players.length) rooms.delete(oldCode);
  else {
    io.to(oldCode).emit("notice","Oyuncu ayrıldı. Yeni oyuncu bekleniyor.");
    broadcast(room);
  }
}

function createRoom(socket) {
  leaveRoom(socket);
  const c = code();
  const room = {
    code:c,
    players:[],
    started:false,
    score:[0,0],
    ball:{x:0,z:0,vx:0,vz:0,owner:null}
  };
  rooms.set(c,room);
  addPlayer(socket,room);
}

function addPlayer(socket,room) {
  if (room.players.length >= 2) {
    sendError(socket,"Bu oda dolu.");
    return;
  }
  leaveRoom(socket);
  const p = {
    id:socket.id,
    x:room.players.length ? 5 : -5,
    z:0,
    ready:false,
    team:room.players.length
  };
  room.players.push(p);
  socket.join(room.code);
  socketRooms.set(socket.id,room.code);

  const info = {code:room.code,player:room.players.length};
  socket.emit("joined",info);
  socket.emit("roomJoined",info);
  socket.emit("notice","Odaya katıldın. Maça hazır olduğunda butona bas.");
  broadcast(room);
}

function joinRoom(socket,value) {
  const c = String(
    typeof value === "object" ? (value.code || value.roomCode || "") : value
  ).trim();
  const room = rooms.get(c);
  if (!room) return sendError(socket,"Oda bulunamadı. Kodu kontrol et.");
  if (room.started) return sendError(socket,"Bu maç zaten başlamış.");
  if (room.players.length >= 2) return sendError(socket,"Oda dolu.");
  addPlayer(socket,room);
}

function quickPlay(socket) {
  let room = [...rooms.values()].find(r =>
    !r.started && r.players.length === 1 && r.players[0].id !== socket.id
  );
  if (!room) {
    createRoom(socket);
    socket.emit("notice","Rakip aranıyor. Bir oyuncu daha bekleniyor.");
  } else {
    addPlayer(socket,room);
    io.to(room.code).emit("notice","Rakip bulundu! İkiniz de hazır olun.");
    io.to(room.code).emit("matchFound",{code:room.code});
  }
}

io.on("connection", socket => {
  socket.emit("notice","NOVA V6 sunucusuna bağlandın.");

  socket.on("createRoom", () => createRoom(socket));
  socket.on("create_room", () => createRoom(socket));
  socket.on("joinRoom", value => joinRoom(socket,value));
  socket.on("join_room", value => joinRoom(socket,value));
  socket.on("quickPlay", () => quickPlay(socket));
  socket.on("quick_play", () => quickPlay(socket));

  socket.on("ready", () => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room) return sendError(socket,"Önce bir odaya katıl.");
    const p = room.players.find(x => x.id === socket.id);
    if (!p) return;
    p.ready = true;
    if (room.players.length === 2 && room.players.every(x => x.ready)) {
      room.started = true;
      room.ball = {x:0,z:0,vx:0,vz:0,owner:null};
      room.players.forEach((x,i) => {
        x.x = i ? 5 : -5;
        x.z = 0;
      });
      io.to(room.code).emit("notice","MAÇ BAŞLADI!");
    } else {
      socket.emit("notice","Hazırsın. Diğer oyuncu bekleniyor.");
    }
    broadcast(room);
  });

  socket.on("input", data => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room || !room.started) return;
    const p = room.players.find(x => x.id === socket.id);
    if (!p) return;
    let x = Number(data?.x) || 0;
    let z = Number(data?.z) || 0;
    const len = Math.hypot(x,z);
    if (len > 1) { x/=len; z/=len; }
    p.x = Math.max(-18,Math.min(18,p.x+x*.42));
    p.z = Math.max(-8,Math.min(8,p.z+z*.42));
  });

  socket.on("action", action => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room || !room.started) return;
    const p = room.players.find(x => x.id === socket.id);
    if (!p) return;
    const b = room.ball;
    const distance = Math.hypot(p.x-b.x,p.z-b.z);

    if (action === "shoot" && b.owner === socket.id) {
      b.owner = null;
      b.vx = p.team === 0 ? 1.15 : -1.15;
      b.vz = (Math.random()-.5)*.5;
    } else if (action === "press" && distance < 2.7) {
      b.owner = socket.id;
      b.vx = b.vz = 0;
    }
  });

  socket.on("disconnect", () => leaveRoom(socket));
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.started) continue;
    const b = room.ball;

    if (b.owner) {
      const p = room.players.find(x => x.id === b.owner);
      if (p) {
        b.x = p.x + (p.team === 0 ? 1 : -1)*.65;
        b.z = p.z;
        b.vx = b.vz = 0;
      } else b.owner = null;
    } else {
      b.x += b.vx;
      b.z += b.vz;
      b.vx *= .985;
      b.vz *= .985;

      for (const p of room.players) {
        if (Math.hypot(p.x-b.x,p.z-b.z)<1.15) {
          b.owner=p.id;
          b.vx=b.vz=0;
          break;
        }
      }
    }

    if (Math.abs(b.x)>20 && Math.abs(b.z)<3.6) {
      const scorer = b.x>0 ? 0 : 1;
      room.score[scorer]++;
      b.x=b.z=b.vx=b.vz=0;
      b.owner=null;
      io.to(room.code).emit("notice","GOOOL! Skor güncellendi.");
    } else {
      b.x=Math.max(-21,Math.min(21,b.x));
      b.z=Math.max(-10,Math.min(10,b.z));
    }
    broadcast(room);
  }
},50);

const PORT = process.env.PORT || 3000;
server.listen(PORT,"0.0.0.0",()=>console.log("NOVA V6 running on "+PORT));
