// server.js — Tracker WebRTC + servidor HTTP estático + Proxy Xtream
// Render injeta a porta via process.env.PORT

const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const urlMod    = require('url');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT || '8765', 10);

// ── Proxy reverso para evitar mixed-content HTTPS→HTTP ──────────
function rewriteM3u8(text, baseUrl) {
    var base = new URL(baseUrl);
    return text.split('\n').map(function(line) {
        var t = line.trim();
        if (!t || t.startsWith('#')) return line;
        var absUrl;
        if (t.startsWith('http://') || t.startsWith('https://')) {
            absUrl = t;
        } else if (t.startsWith('/')) {
            absUrl = base.origin + t;
        } else {
            absUrl = base.href.replace(/[^/]*$/, '') + t;
        }
        return '/proxy?url=' + encodeURIComponent(absUrl);
    }).join('\n');
}

function handleProxy(req, res, targetUrl, hops) {
    hops = hops || 0;
    if (hops > 5) { res.writeHead(508); res.end('Too many redirects'); return; }

    if (!targetUrl) {
        res.writeHead(400); res.end('Missing url'); return;
    }
    var target;
    try { target = new URL(targetUrl); } catch(e) {
        res.writeHead(400); res.end('Bad url'); return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        res.writeHead(400); res.end('Bad protocol'); return;
    }

    var lib = target.protocol === 'https:' ? https : http;
    var options = {
        hostname: target.hostname,
        port:     target.port || (target.protocol === 'https:' ? 443 : 80),
        path:     target.pathname + target.search,
        method:   'GET',
        headers:  { 'User-Agent': 'Mozilla/5.0', 'Connection': 'keep-alive' },
        timeout:  20000
    };

    var proxyReq = lib.request(options, function(proxyRes) {
        // Segue redirecionamentos (301/302/303/307/308)
        var sc = proxyRes.statusCode;
        if ((sc === 301 || sc === 302 || sc === 303 || sc === 307 || sc === 308) && proxyRes.headers.location) {
            var loc = proxyRes.headers.location;
            if (!loc.startsWith('http')) loc = new URL(loc, targetUrl).href;
            proxyRes.resume();
            handleProxy(req, res, loc, hops + 1);
            return;
        }

        var ct = proxyRes.headers['content-type'] || '';
        var isM3u8 = ct.includes('mpegurl') || ct.includes('x-mpegurl') ||
                     targetUrl.includes('.m3u8') || targetUrl.includes('get.php');

        if (isM3u8) {
            var chunks = [];
            proxyRes.on('data', function(c) { chunks.push(c); });
            proxyRes.on('end', function() {
                var text = Buffer.concat(chunks).toString('utf8');

                // Não começa com #EXTM3U — provavelmente TS binário ou HTML de erro
                if (!text.trim().startsWith('#EXTM3U')) {
                    res.writeHead(200, { 'Content-Type': ct || 'video/MP2T', 'Access-Control-Allow-Origin': '*' });
                    res.end(Buffer.concat(chunks));
                    return;
                }

                // É um M3U simples (playlist de canais), não HLS com segmentos
                // HLS sempre tem #EXT-X-VERSION ou #EXT-X-TARGETDURATION ou #EXT-X-STREAM-INF
                var isHLS = text.includes('#EXT-X-');
                if (!isHLS) {
                    // Extrai a primeira URL do M3U e redireciona pelo proxy
                    var lines = text.split('\n');
                    var realUrl = null;
                    for (var i = 0; i < lines.length; i++) {
                        var l = lines[i].trim();
                        if (l.startsWith('http://') || l.startsWith('https://')) {
                            realUrl = l; break;
                        }
                    }
                    if (realUrl) {
                        res.writeHead(302, {
                            'Location': '/proxy?url=' + encodeURIComponent(realUrl),
                            'Access-Control-Allow-Origin': '*'
                        });
                        res.end();
                        return;
                    }
                }

                var rewritten = rewriteM3u8(text, targetUrl);
                res.writeHead(200, {
                    'Content-Type':                'application/vnd.apple.mpegurl',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control':               'no-cache'
                });
                res.end(rewritten);
            });
        } else {
            var headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
            if (ct) headers['Content-Type'] = ct;
            var cl = proxyRes.headers['content-length'];
            if (cl) headers['Content-Length'] = cl;
            res.writeHead(sc, headers);
            proxyRes.pipe(res);
        }
    });

    proxyReq.on('error', function(err) {
        if (!res.headersSent) { res.writeHead(502); res.end('Proxy error: ' + err.message); }
    });
    proxyReq.on('timeout', function() {
        proxyReq.destroy();
        if (!res.headersSent) { res.writeHead(504); res.end('Proxy timeout'); }
    });
    proxyReq.end();
}

// ── Servidor HTTP (serve index.html + proxy) ────────────────────
const httpServer = http.createServer(function(req, res) {
    var parsed = urlMod.parse(req.url, true);

    if (parsed.pathname === '/proxy') {
        handleProxy(req, res, parsed.query.url || '');
        return;
    }

    // Debug: mostra o que o servidor remoto retorna (primeiros 2000 chars)
    if (parsed.pathname === '/proxy-debug') {
        var dbUrl = parsed.query.url || '';
        if (!dbUrl) { res.writeHead(400); res.end('Missing url'); return; }
        var dbTarget;
        try { dbTarget = new URL(dbUrl); } catch(e) { res.writeHead(400); res.end('Bad url'); return; }
        var dbLib = dbTarget.protocol === 'https:' ? https : http;
        var dbOpts = {
            hostname: dbTarget.hostname,
            port: dbTarget.port || (dbTarget.protocol === 'https:' ? 443 : 80),
            path: dbTarget.pathname + dbTarget.search,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        };
        var dbReq = dbLib.request(dbOpts, function(dbRes) {
            var buf = [];
            dbRes.on('data', function(c) { buf.push(c); });
            dbRes.on('end', function() {
                var body = Buffer.concat(buf);
                var text = body.slice(0, 2000).toString('utf8');
                var info = {
                    status: dbRes.statusCode,
                    contentType: dbRes.headers['content-type'] || '',
                    location: dbRes.headers['location'] || '',
                    bodyLength: body.length,
                    bodyPreview: text
                };
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(info, null, 2));
            });
        });
        dbReq.on('error', function(e) { res.writeHead(502); res.end(e.message); });
        dbReq.on('timeout', function() { dbReq.destroy(); res.writeHead(504); res.end('timeout'); });
        dbReq.end();
        return;
    }

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
    console.log('[IPTV P2P Tracker] HTTP + WS + Proxy rodando em http://0.0.0.0:' + PORT);
});
