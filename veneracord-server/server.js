const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { networkInterfaces } = require('node:os');
const { isIPv4 } = require('node:net');

const rooms = new Map();
const voiceChannels = new Set(['lobby', 'faceit', 'chill']);
const textChannels = new Set(['general', 'dogovor', 'meme']);
const localProof = randomUUID();
const teamKey = process.env.VENERACORD_TEAM_KEY;
const ownerSecret = process.env.VENERACORD_OWNER_SECRET;
const hosted = process.env.VENERACORD_HOSTED === '1';
if (hosted && (!/^[a-f0-9]{32}$/.test(teamKey || '') || !/^[a-f0-9]{64}$/.test(ownerSecret || '')))
  throw new Error('Hosted Veneracord requires a team key and owner secret.');
let port = Number(process.env.VENERACORD_PORT || (hosted && process.env.PORT) || 47821);
const kicked = new Map();
const page = hosted ? null : fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function privateRelay(address) {
  if (typeof address !== 'string') return false;
  const [ip, targetPort, extra] = address.split(':');
  if (extra !== undefined || !isIPv4(ip) || !/^\d{1,5}$/.test(targetPort) ||
      Number(targetPort) < 1 || Number(targetPort) > 65535) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254);
}

function hostedRelay(address) {
  return typeof address === 'string' && /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.onrender\.com$/.test(address);
}

function localPage() {
  const addresses = Object.values(networkInterfaces()).flat()
    .filter(entry => entry.family === 'IPv4' && !entry.internal)
    .map(entry => entry.address + ':' + port).filter(privateRelay);
  return page.replace('null /* local desktop config */',
    JSON.stringify({proof:localProof, addresses:[...new Set(addresses)]}));
}
const reply = (res, status, body) => {
  res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'});
  res.end(JSON.stringify(body));
};

setInterval(() => {
  for (const [id, entry] of kicked) if (entry.until <= Date.now()) kicked.delete(id);
  for (const [key, room] of rooms) {
    for (const [id, p] of room) if (Date.now() - p.seen > 45000) room.delete(id);
    if (!room.size) rooms.delete(key);
  }
}, 3000).unref();

const server = http.createServer(async (req, res) => {
  try {
    const local = req.socket.remoteAddress === '127.0.0.1';
    const origin = 'http://127.0.0.1:' + port;
    const localUi = !hosted && local && req.headers.host === '127.0.0.1:' + port;
    if (req.method === 'GET' && req.url === '/health' && hosted) return reply(res, 200, {ok:true});
    if (req.method === 'GET' && req.url === '/' && localUi) {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      return res.end(localPage());
    }
    if (req.method !== 'POST' || !['/api','/relay'].includes(req.url) ||
        !req.headers['content-type']?.startsWith('application/json'))
      return reply(res, 404, {});
    if (req.headers.origin && (!localUi || req.headers.origin !== origin)) return reply(res, 403, {});
    if (req.url === '/relay' && !localUi) return reply(res, 403, {});
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 65536) return reply(res, 413, {});
    }
    const data = JSON.parse(raw);
    if (req.url === '/relay') {
      const online = hostedRelay(data.relay);
      if (!online && !privateRelay(data.relay)) return reply(res, 400, {});
      const {relay, proof, ...payload} = data;
      if (payload.create && !online) return reply(res, 403, {});
      if (!online) delete payload.owner;
      const result = await fetch((online ? relay : 'http://' + relay) + '/api', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload),
        signal:AbortSignal.timeout(online && payload.action === 'join' ? 20000 : 4500), redirect:'error'
      });
      return reply(res, result.status, await result.json());
    }
    const {action, key, id, token, name, to, signal, create, channel, message, after, voice, muted, deafened, holdInbox, sharing, watching} = data;
    const suppliedOwner = data.owner;
    const isHost = hosted
      ? typeof suppliedOwner === 'string' && /^[a-f0-9]{64}$/.test(suppliedOwner) &&
        timingSafeEqual(Buffer.from(suppliedOwner), Buffer.from(ownerSecret))
      : localUi && data.proof === localProof;
    if (typeof key !== 'string' || !/^[a-f0-9]{32}$/.test(key)) return reply(res, 400, {});
    if (hosted && key !== teamKey) return reply(res, 404, {});
    let room = rooms.get(key);
    if (action === 'join') {
      if (create && !isHost) return reply(res, 403, {});
      if (!room && !create && !hosted) return reply(res, 404, {});
      if (create && room) {
        for (const [id, member] of room) if (member.admin) room.delete(id);
      }
      if ((!room && rooms.size >= 64) ||
          (room && (room.size >= 6 || (!create && [...room.values()].filter(member => !member.admin).length >= 5))))
        return reply(res, 429, {});
      if (!room) {
        room = new Map();
        room.messages = new Map();
        room.sequence = 0;
        rooms.set(key, room);
      }
      const id = randomUUID();
      const token = randomUUID();
      const admin = Boolean(create && isHost);
      room.set(id, {token, admin, name:String(name || 'Igrač').trim().slice(0,24) || 'Igrač',
        seen:Date.now(), inbox:[], voice:null, muted:false, deafened:false, sharing:null, watching:null});
      return reply(res, 200, {id, token, admin});
    }
    if (kicked.get(id)?.token === token && kicked.has(id)) return reply(res, 410, {});
    const member = room?.get(id);
    if (!member || member.token !== token) return reply(res, 404, {});
    if (action === 'kick' || action === 'rename') {
      if (!member.admin || !isHost) return reply(res, 403, {});
      const target = room.get(to);
      if (!target) return reply(res, 404, {});
      if (action === 'kick') {
        if (target.admin) return reply(res, 403, {});
        kicked.set(to,{token:target.token,until:Date.now()+300000});
        room.delete(to);
      } else {
        const label = typeof name === 'string' ? name.trim() : '';
        if (!label || label.length > 24) return reply(res, 400, {});
        target.name = label;
      }
    }
    member.seen = Date.now();
    if (action === 'leave') room.delete(id);
    if (action === 'voice') {
      if (channel !== null && !voiceChannels.has(channel)) return reply(res, 400, {});
      member.voice = channel;
      member.sharing = null;
      member.watching = null;
      member.deafened = Boolean(channel && deafened === true);
      member.muted = Boolean(channel && (muted === true || member.deafened));
      member.inbox.length = 0;
    }
    if (action === 'poll' && member.voice && voice === member.voice && typeof muted === 'boolean') {
      member.deafened = deafened === true;
      member.muted = muted || member.deafened;
      member.sharing = ['screen','camera'].includes(sharing) ? sharing : null;
      const broadcaster = room.get(watching);
      member.watching = broadcaster?.voice === member.voice && watching !== id ? watching : null;
    }
    if (action === 'send') {
      const peer = room.get(to);
      if (member.voice && peer?.voice === member.voice && peer.inbox.length < 128)
        peer.inbox.push({from:id, signal, channel:member.voice});
    }
    if (action === 'message') {
      const body = typeof message === 'string' ? message.trim() : '';
      if (!textChannels.has(channel) || !body || body.length > 500) return reply(res, 400, {});
      if (Date.now() - (member.lastMessage || 0) < 350) return reply(res, 429, {});
      member.lastMessage = Date.now();
      const log = room.messages.get(channel) || [];
      log.push({id:++room.sequence, name:member.name, body, time:Date.now()});
      if (log.length > 60) log.shift();
      room.messages.set(channel, log);
    }
    return reply(res, 200, {
      members:[...room].map(([id,p]) => ({id,name:p.name,voice:p.voice,muted:p.muted,deafened:p.deafened,admin:p.admin,sharing:p.sharing,watching:p.watching})),
      inbox: action === 'poll' && holdInbox !== true ? member.inbox.splice(0) : [],
      messages: action === 'poll' && textChannels.has(channel)
        ? (room.messages.get(channel) || []).filter(item => item.id > (Number(after) || 0)) : []
    });
  } catch {
    if (!res.headersSent) reply(res, 502, {});
  }
}).listen(port, '0.0.0.0', () => {
  port = server.address().port;
  console.log('Veneracord: http://127.0.0.1:' + port);
});




server.on('error', error => {
  if (error.code === 'EADDRINUSE' && port === 47821) {
    server.listen(0, '0.0.0.0');
    return;
  }
  console.error(error.message);
  process.exitCode = 1;
});


