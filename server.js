const express=require("express");
const http=require("http");
const {Server}=require("socket.io");
const crypto=require("crypto");

const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:"*"}});
app.use(express.static("public"));
app.get("/health",(req,res)=>res.json({status:"online",version:"NOVA V7 FINAL"}));

const rooms=new Map();
const socketRooms=new Map();

function newCode(){
 let c;
 do{c=String(100000+crypto.randomInt(900000));}
 while(rooms.has(c));
 return c;
}
function notify(room,msg){io.to(room.code).emit("notice",msg);}
function getRoom(socket){return rooms.get(socketRooms.get(socket.id));}

function snapshot(r){
 return {
  code:r.code,
  started:r.started,
  finished:r.finished,
  remaining:r.remaining,
  score:[...r.score],
  winner:r.winner,
  players:r.players.map(p=>({
   id:p.id,x:p.x,z:p.z,ready:p.ready,team:p.team
  })),
  ball:{x:r.ball.x,z:r.ball.z,owner:r.ball.owner}
 };
}
function sendState(r){io.to(r.code).emit("state",snapshot(r));}

function leave(socket){
 const c=socketRooms.get(socket.id);
 if(!c)return;
 socketRooms.delete(socket.id);
 socket.leave(c);
 const r=rooms.get(c);
 if(!r)return;
 r.players=r.players.filter(p=>p.id!==socket.id);
 r.started=false;
 r.finished=false;
 r.winner=null;
 r.players.forEach(p=>p.ready=false);
 if(!r.players.length)rooms.delete(c);
 else{
  notify(r,"Rakip odadan ayrıldı. Yeni oyuncu bekleniyor.");
  sendState(r);
 }
}

function makeRoom(){
 const c=newCode();
 const r={
  code:c,players:[],started:false,finished:false,
  remaining:180,score:[0,0],winner:null,
  ball:{x:0,z:0,vx:0,vz:0,owner:null},
  rematch:new Set()
 };
 rooms.set(c,r);
 return r;
}
function addPlayer(socket,r){
 if(r.players.length>=2)return socket.emit("errorMessage","Oda dolu.");
 leave(socket);
 const p={
  id:socket.id,
  x:r.players.length===0?-5:5,
  z:0,ready:false,team:r.players.length
 };
 r.players.push(p);
 socket.join(r.code);
 socketRooms.set(socket.id,r.code);
 const info={code:r.code,player:r.players.length};
 socket.emit("joined",info);
 socket.emit("roomJoined",info);
 notify(r,"Oyuncu odaya katıldı.");
 sendState(r);
}
function createRoom(socket){
 leave(socket);
 const r=makeRoom();
 addPlayer(socket,r);
 socket.emit("notice","Odan hazır. Kodunu arkadaşınla paylaş.");
}
function joinRoom(socket,value){
 const c=String(typeof value==="object"?(value.code||value.roomCode||""):value).trim();
 const r=rooms.get(c);
 if(!r)return socket.emit("errorMessage","Oda bulunamadı. Oda kodunu kontrol et.");
 if(r.started||r.finished)return socket.emit("errorMessage","Bu maç şu anda devam ediyor veya tamamlandı.");
 if(r.players.length>=2)return socket.emit("errorMessage","Oda dolu.");
 addPlayer(socket,r);
}
function quickPlay(socket){
 const r=[...rooms.values()].find(x=>!x.started&&!x.finished&&x.players.length===1&&!x.players.some(p=>p.id===socket.id));
 if(r){
  addPlayer(socket,r);
  notify(r,"Rakip bulundu! İkiniz de hazır olun.");
  io.to(r.code).emit("matchFound",{code:r.code});
 }else{
  createRoom(socket);
  socket.emit("notice","Rakip aranıyor...");
 }
}
function resetMatch(r){
 r.started=false;
 r.finished=false;
 r.remaining=180;
 r.score=[0,0];
 r.winner=null;
 r.ball={x:0,z:0,vx:0,vz:0,owner:null};
 r.players.forEach((p,i)=>{
  p.x=i===0?-5:5;p.z=0;p.ready=false;
 });
 r.rematch.clear();
}
function startMatch(r){
 if(r.players.length!==2||!r.players.every(p=>p.ready))return;
 r.started=true;
 r.finished=false;
 r.remaining=180;
 r.score=[0,0];
 r.winner=null;
 r.ball={x:0,z:0,vx:0,vz:0,owner:null};
 r.players.forEach((p,i)=>{p.x=i===0?-5:5;p.z=0;});
 notify(r,"MAÇ BAŞLADI!");
 sendState(r);
}
function finishMatch(r){
 r.started=false;
 r.finished=true;
 r.winner=r.score[0]===r.score[1]?"Berabere":r.score[0]>r.score[1]?"Mavi takım":"Kırmızı takım";
 notify(r,"MAÇ BİTTİ!");
 sendState(r);
}

io.on("connection",socket=>{
 socket.emit("notice","NOVA V7 sunucusuna bağlandın.");

 socket.on("createRoom",()=>createRoom(socket));
 socket.on("create_room",()=>createRoom(socket));
 socket.on("joinRoom",v=>joinRoom(socket,v));
 socket.on("join_room",v=>joinRoom(socket,v));
 socket.on("quickPlay",()=>quickPlay(socket));
 socket.on("quick_play",()=>quickPlay(socket));

 socket.on("ready",()=>{
  const r=getRoom(socket);
  if(!r)return socket.emit("errorMessage","Önce bir odaya katıl.");
  if(r.finished)return socket.emit("errorMessage","Rövanş butonunu kullan.");
  const p=r.players.find(x=>x.id===socket.id);
  if(!p)return;
  p.ready=true;
  if(r.players.length===2&&r.players.every(x=>x.ready))startMatch(r);
  else notify(r,"Oyuncu hazır. Diğer oyuncu bekleniyor.");
  sendState(r);
 });

 socket.on("rematch",()=>{
  const r=getRoom(socket);
  if(!r||!r.finished)return;
  r.rematch.add(socket.id);
  const p=r.players.find(x=>x.id===socket.id);
  if(p)p.ready=true;
  notify(r,"Rövanş isteği alındı.");
  if(r.players.length===2&&r.players.every(x=>r.rematch.has(x.id))){
   resetMatch(r);
   r.players.forEach(p=>p.ready=true);
   startMatch(r);
  }else sendState(r);
 });

 socket.on("input",data=>{
  const r=getRoom(socket);
  if(!r||!r.started)return;
  const p=r.players.find(x=>x.id===socket.id);
  if(!p)return;
  let x=Number(data?.x)||0,z=Number(data?.z)||0;
  const n=Math.hypot(x,z);
  if(n>1){x/=n;z/=n;}
  const speed=data?.sprint===true?0.50:0.38;
  p.x=Math.max(-18,Math.min(18,p.x+x*speed));
  p.z=Math.max(-8,Math.min(8,p.z+z*speed));
 });

 socket.on("action",action=>{
  const r=getRoom(socket);
  if(!r||!r.started)return;
  const p=r.players.find(x=>x.id===socket.id);
  if(!p)return;
  const b=r.ball;
  const d=Math.hypot(p.x-b.x,p.z-b.z);
  if(action==="pass"&&b.owner===socket.id){
   b.owner=null;
   b.vx=p.team===0?0.95:-0.95;
   b.vz=(Math.random()-.5)*.30;
  }
  if(action==="dribble"&&b.owner===socket.id){
   const direction=p.team===0?1:-1;
   p.x=Math.max(-18,Math.min(18,p.x+direction*1.15));
   b.x=p.x+(p.team===0?.7:-.7);
   b.z=p.z;
   b.vx=0;
   b.vz=0;
  }
  if(action==="shoot"&&b.owner===socket.id){
   b.owner=null;
   b.vx=p.team===0?1.25:-1.25;
   b.vz=(Math.random()-.5)*.65;
  }
  if(action==="press"&&d<2.8){
   b.owner=socket.id;b.vx=0;b.vz=0;
  }
 });

 socket.on("leaveRoom",()=>leave(socket));
 socket.on("disconnect",()=>leave(socket));
});

setInterval(()=>{
 for(const r of rooms.values()){
  if(!r.started)continue;
  r.remaining=Math.max(0,r.remaining-.05);
  const b=r.ball;

  if(b.owner){
   const p=r.players.find(x=>x.id===b.owner);
   if(p){
    b.x=p.x+(p.team===0?.7:-.7);
    b.z=p.z;
    b.vx=b.vz=0;
   }else b.owner=null;
  }else{
   b.x+=b.vx;b.z+=b.vz;
   b.vx*=.985;b.vz*=.985;
   for(const p of r.players){
    if(Math.hypot(p.x-b.x,p.z-b.z)<1.15){
     b.owner=p.id;b.vx=b.vz=0;break;
    }
   }
  }

  if(Math.abs(b.x)>=20&&Math.abs(b.z)<3.7){
   r.score[b.x>0?0:1]++;
   b.x=b.z=b.vx=b.vz=0;b.owner=null;
   notify(r,"GOOOL! Skor: "+r.score[0]+" - "+r.score[1]);
   if(r.score[0]>=3||r.score[1]>=3){finishMatch(r);continue;}
  }
  if(r.remaining<=0){finishMatch(r);continue;}
  b.x=Math.max(-21,Math.min(21,b.x));
  b.z=Math.max(-10,Math.min(10,b.z));
  sendState(r);
 }
},50);

const PORT=process.env.PORT||3000;
server.listen(PORT,"0.0.0.0",()=>console.log("NOVA V7 FINAL running on "+PORT));
