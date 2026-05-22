// server.js — Tracker WebRTC + servidor HTTP estático
// Render injeta a porta via process.env.PORT

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT || '8765', 10);

// ── Servidor HTTP (serve o index.html) ──────────────────────────
const httpServer = http.createServer(function(req, res) {
    var filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, function(err, data) {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
    });
});

// ── Servidor WebSocket (tracker P2P) ────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

// rooms: Map<streamId, Map<clientId, WebSocket>>
const rooms = new Map();
let clientIdCounter = 0;

console.log('[IPTV P2P Tracker] Iniciando na porta ' + PORT);

wss.on('connection', function(ws, req) {
    const clientId = ++clientIdCounter;
    let currentRoom = null;

    const addr = (req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress : '?';
    console.log('[#' + clientId + '] Conectado de ' + addr);

    ws.on('message', function(raw) {
        var data;
        try { data = JSON.parse(raw); } catch (e) { return; }

        switch (data.type) {
            case 'join':
                currentRoom = String(data.streamId || '');
                handleJoin(ws, clientId, currentRoom);
                break;
            case 'offer':
            case 'answer':
            case 'ice-candidate':
                broadcastToRoom(currentRoom, ws, raw);
                break;
            default:
                break;
        }
    });

    ws.on('close', function() {
        if (currentRoom !== null) leaveRoom(currentRoom, clientId);
        console.log('[#' + clientId + '] Desconectado');
    });

    ws.on('error', function(err) {
        console.error('[#' + clientId + '] Erro: ' + err.message);
    });
});

function handleJoin(ws, clientId, streamId) {
    if (!streamId) return;

    if (!rooms.has(streamId)) rooms.set(streamId, new Map());
    const room = rooms.get(streamId);
    room.set(clientId, ws);

    console.log('[Sala: ' + streamId + '] #' + clientId + ' entrou. Peers: ' + room.size);

    room.forEach(function(client, id) {
        if (id !== clientId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'peer-joined', peerId: clientId, totalPeers: room.size }));
        }
    });

    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'room-info', streamId: streamId, peerId: clientId, totalPeers: room.size }));
    }

    broadcastPeerCount(streamId, room);
}

function leaveRoom(streamId, clientId) {
    if (!rooms.has(streamId)) return;
    const room = rooms.get(streamId);
    room.delete(clientId);

    console.log('[Sala: ' + streamId + '] #' + clientId + ' saiu. Peers: ' + room.size);

    if (room.size === 0) {
        rooms.delete(streamId);
        console.log('[Sala: ' + streamId + '] Encerrada');
    } else {
        broadcastPeerCount(streamId, room);
    }
}

function broadcastToRoom(streamId, senderWs, message) {
    if (!streamId || !rooms.has(streamId)) return;
    rooms.get(streamId).forEach(function(client) {
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastPeerCount(streamId, room) {
    const msg = JSON.stringify({ type: 'peer-count', count: room ? room.size : 0 });
    if (room) {
        room.forEach(function(client) {
            if (client.readyState === WebSocket.OPEN) client.send(msg);
        });
    }
}

// Limpeza de sockets zumbis a cada 30s
setInterval(function() {
    rooms.forEach(function(room, streamId) {
        room.forEach(function(client, id) {
            if (client.readyState !== WebSocket.OPEN) room.delete(id);
        });
        if (room.size === 0) rooms.delete(streamId);
    });
}, 30000);

// ── Sobe o servidor ─────────────────────────────────────────────
httpServer.listen(PORT, function() {
    console.log('[IPTV P2P Tracker] HTTP + WS rodando em http://0.0.0.0:' + PORT);
});
