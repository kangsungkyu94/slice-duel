const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, 'public')));

// Room state: { code: { players: Map<socketId, {name, isHost}>, gameStarted: bool } }
const rooms = new Map();

function broadcastPlayerList(code) {
  const room = rooms.get(code);
  if (!room) return;
  const list = [];
  for (const [sid, info] of room.players) {
    list.push({ id: sid, name: info.name, isHost: info.isHost });
  }
  io.to('game:' + code).emit('player-list', list);
}

io.on('connection', (socket) => {
  let currentRoom = null; // room code this socket is in

  socket.on('create-room', ({ code, name }) => {
    if (rooms.has(code)) {
      socket.emit('room-error', '이미 존재하는 방입니다');
      return;
    }
    const room = { players: new Map(), gameStarted: false };
    room.players.set(socket.id, { name, isHost: true });
    rooms.set(code, room);
    currentRoom = code;
    socket.join('game:' + code);
    socket.emit('room-joined', { code, isHost: true });
    broadcastPlayerList(code);
  });

  socket.on('join-room', ({ code, name }) => {
    const room = rooms.get(code);
    if (!room) {
      socket.emit('room-error', '존재하지 않는 방입니다');
      return;
    }
    if (room.gameStarted) {
      socket.emit('room-error', '이미 게임이 진행 중입니다');
      return;
    }
    if (room.players.size >= 8) {
      socket.emit('room-error', '방이 가득 찼습니다 (최대 8명)');
      return;
    }
    room.players.set(socket.id, { name, isHost: false });
    currentRoom = code;
    socket.join('game:' + code);
    socket.emit('room-joined', { code, isHost: false });
    broadcastPlayerList(code);
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom(socket);
  });

  // Host starts the game
  socket.on('game-start', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const info = room.players.get(socket.id);
    if (!info || !info.isHost) return;
    room.gameStarted = true;
    // Attach player list to game-start data
    const playerList = [];
    for (const [sid, pinfo] of room.players) {
      playerList.push({ id: sid, name: pinfo.name, isHost: pinfo.isHost });
    }
    data.players = playerList;
    io.to('game:' + currentRoom).emit('game-start', data);
  });

  // Current player broadcasts their state (position, rotation, timer)
  socket.on('presence', (data) => {
    if (!currentRoom) return;
    socket.to('game:' + currentRoom).emit('presence', { id: socket.id, gs: data });
  });

  // Cut event
  socket.on('cut', (data) => {
    if (!currentRoom) return;
    socket.to('game:' + currentRoom).emit('cut', data);
  });

  // End event (miss or timeout)
  socket.on('end', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) room.gameStarted = false;
    socket.to('game:' + currentRoom).emit('end', data);
  });

  // Back to waiting after game ends
  socket.on('back-to-waiting', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.gameStarted = false;
      broadcastPlayerList(currentRoom);
    }
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });

  function leaveCurrentRoom(sock) {
    if (!currentRoom) return;
    const code = currentRoom;
    const room = rooms.get(code);
    if (!room) { currentRoom = null; return; }

    const wasHost = room.players.get(sock.id)?.isHost;
    room.players.delete(sock.id);
    sock.leave('game:' + code);

    if (room.players.size === 0) {
      rooms.delete(code);
    } else {
      // If host left, assign new host
      if (wasHost) {
        const first = room.players.keys().next().value;
        if (first) {
          room.players.get(first).isHost = true;
          io.to(first).emit('you-are-host');
        }
      }
      broadcastPlayerList(code);
    }
    currentRoom = null;
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Slice Duel server running on port ${PORT}`);
});
