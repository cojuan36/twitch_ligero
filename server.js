require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const NodeMediaServer = require('node-media-server');
const { Server } = require('socket.io');
const { createServer } = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { join } = require('node:path');
const db = require('./db');

const app = express();
const server = createServer(app);
const io = new Server(server, { maxHttpBufferSize: 4096 });
const media = join(__dirname, 'media');
const port = Number(process.env.PORT || 3000);
const rtmp = Number(process.env.RTMP_PORT || 1935);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const categories = ['Videojuegos', 'Programación', 'Educación', 'Música', 'Charlas', 'Arte'];
const day = 86400000;
const secret = () => 'sk_' + randomBytes(12).toString('hex');
const channel = (name) => db.prepare('SELECT * FROM users WHERE username = ?').get(name);
const room = (name) => 'ch:' + name;
const viewers = (name) => io.sockets.adapter.rooms.get(room(name))?.size || 0;
const followerCount = (id) => db.prepare('SELECT count(*) n FROM follows WHERE channel_id = ?').get(id).n;
const follow = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND channel_id = ?');
const tokenFrom = (cookie) => (cookie || '').match(/(?:^|;\s*)sl_token=([a-f0-9]{48})(?:;|$)/)?.[1] || '';
const session = db.prepare(`SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id
  WHERE s.token = ? AND s.created_at > datetime('now', '-7 days')`);
const fail = (res, status, error) => res.status(status).json({ error });

function profile(user) {
  const { username, title, category, bio, is_live } = user;
  return { username, title, category, bio, is_live: Boolean(is_live),
    viewers: viewers(username), followers: followerCount(user.id),
    thumb: '/media/live/' + username + '/thumb.jpg?t=' + Math.floor(Date.now() / 30000) };
}
function issueSession(req, res, id) {
  const token = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, id);
  res.cookie('sl_token', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 7 * day })
    .json({ ok: true });
}
function auth(req, res, next) {
  if (!req.user) return fail(res, 401, 'Inicia sesión');
  next();
}
function credentials(body) {
  return [String(body.username || '').trim().toLowerCase(), typeof body.password === 'string' ? body.password : ''];
}

app.use(express.json({ limit: '8kb' }));
app.use('/api', (req, res, next) => {
  req.token = tokenFrom(req.headers.cookie);
  req.user = session.get(req.token);
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(join(__dirname, 'public')));
app.use('/vendor/hls.js', express.static(join(__dirname, 'node_modules/hls.js/dist')));
app.use('/media/live', express.static(join(media, 'live'), {
  setHeaders(res, file) {
    if (file.endsWith('.m3u8') || file.endsWith('.ts')) res.setHeader('Cache-Control', 'no-store');
  }
}));
app.get('/c/:username', (_, res) => res.sendFile(join(__dirname, 'public/channel.html')));
app.get('/api/health', (_, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/api/me', (req, res) => res.json({ user: req.user ? profile(req.user) : null }));

app.post('/api/register', async (req, res, next) => {
  const [name, password] = credentials(req.body);
  if (!/^[a-z0-9_]{3,20}$/.test(name)) return fail(res, 400, 'Usa 3–20 letras, números o guiones bajos');
  if (password.length < 6 || Buffer.byteLength(password) > 72) return fail(res, 400, 'La contraseña requiere al menos 6 caracteres y hasta 72 bytes');
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare(`INSERT INTO users (username, password_hash, stream_key, title)
      VALUES (?, ?, ?, ?) ON CONFLICT(username) DO NOTHING`).run(name, hash, secret(), 'Directos de ' + name);
    if (!result.changes) return fail(res, 409, 'El usuario ya existe');
    issueSession(req, res, result.lastInsertRowid);
  } catch (error) { next(error); }
});
app.post('/api/login', async (req, res, next) => {
  const [name, password] = credentials(req.body);
  try {
    const user = channel(name);
    if (!user || Buffer.byteLength(password) > 72 || !await bcrypt.compare(password, user.password_hash)) {
      return fail(res, 401, 'Credenciales incorrectas');
    }
    issueSession(req, res, user.id);
  } catch (error) { next(error); }
});
app.post('/api/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.clearCookie('sl_token').json({ ok: true });
});

app.get('/api/categories', (_, res) => {
  const count = db.prepare('SELECT count(*) n FROM users WHERE category = ? AND is_live = 1');
  res.json(categories.map(name => ({ name, live: count.get(name).n })));
});
app.get('/api/channels', (req, res) => {
  const { category, live } = req.query;
  const rows = db.prepare('SELECT * FROM users ORDER BY is_live DESC, username').all();
  res.json(rows.filter(user => (!category || user.category === category) && (live !== '1' || user.is_live)).map(profile));
});
app.get('/api/following', auth, (req, res) => {
  const rows = db.prepare(`SELECT u.* FROM users u JOIN follows f ON u.id = f.channel_id
    WHERE f.follower_id = ? ORDER BY is_live DESC, username`).all(req.user.id);
  res.json(rows.map(profile));
});
app.get('/api/channels/:username', (req, res) => {
  const user = channel(req.params.username);
  if (!user) return fail(res, 404, 'Canal no encontrado');
  const dir = join(media, 'live', user.username);
  const url = '/media/live/' + user.username + '/';
  const vods = fs.existsSync(dir) ? fs.readdirSync(dir)
    .filter(file => file.endsWith('.mp4') && fs.statSync(join(dir, file), { throwIfNoEntry: false })?.size > 0)
    .sort().reverse().map(file => ({ file, url: url + encodeURIComponent(file) })) : [];
  res.json({ ...profile(user), hls: url + 'index.m3u8', vods,
    following: Boolean(req.user && follow.get(req.user.id, user.id)) });
});
app.post('/api/channels/:username/follow', auth, (req, res) => {
  const user = channel(req.params.username);
  if (!user) return fail(res, 404, 'Canal no encontrado');
  if (user.id === req.user.id) return fail(res, 400, 'Este es tu propio canal');
  const ids = [req.user.id, user.id];
  const following = !follow.get(...ids);
  db.prepare(following ? 'INSERT INTO follows VALUES (?, ?)' :
    'DELETE FROM follows WHERE follower_id = ? AND channel_id = ?').run(...ids);
  res.json({ following, followers: followerCount(user.id) });
});
app.get('/api/dashboard', auth, (req, res) => {
  const user = req.user;
  res.json({ ...profile(user), categories, obs_key: user.username + '?key=' + user.stream_key,
    rtmp_url: 'rtmp://' + (process.env.PUBLIC_HOST || req.hostname) + ':' + rtmp + '/live' });
});
app.put('/api/dashboard', auth, (req, res) => {
  const { username } = req.user;
  const title = String(req.body.title || '').trim().slice(0, 120) || req.user.title;
  const category = categories.includes(req.body.category) ? req.body.category : req.user.category;
  const bio = String(req.body.bio ?? req.user.bio).slice(0, 300);
  db.prepare('UPDATE users SET title = ?, category = ?, bio = ? WHERE username = ?').run(title, category, bio, username);
  io.to(room(username)).emit('channel:update', { title, category, bio });
  res.json({ ok: true });
});
app.post('/api/dashboard/regenerate-key', auth, (req, res) => {
  const key = secret();
  db.prepare('UPDATE users SET stream_key = ? WHERE id = ?').run(key, req.user.id);
  res.json({ obs_key: req.user.username + '?key=' + key });
});
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (!error.status) console.error(error);
  fail(res, error.status || 500, error.status ? 'Solicitud no válida' : 'Error del servidor');
});

function updateViewers(name) {
  if (name) io.to(room(name)).emit('viewers', viewers(name));
}
io.on('connection', socket => {
  const token = tokenFrom(socket.handshake.headers.cookie);
  let name;
  let last = 0;
  socket.on('join', target => {
    if (typeof target !== 'string' || target === name || !channel(target)) return;
    if (name) socket.leave(room(name));
    updateViewers(name);
    name = target;
    socket.join(room(name));
    updateViewers(name);
  });
  socket.on('chat', input => {
    if (!name || typeof input !== 'string') return;
    const user = session.get(token);
    if (!user) return socket.emit('chat:error', 'Inicia sesión para escribir');
    const text = input.trim().slice(0, 300);
    if (!text) return;
    const at = Date.now();
    if (at - last < 700) return socket.emit('chat:error', 'Espera un momento antes de enviar otro mensaje');
    last = at;
    const colors = ['#2ec4b6', '#ff7a59', '#a9b7ff', '#ffcc69'];
    const color = colors[user.id % colors.length];
    io.to(room(name)).emit('chat', { user: user.username, text, color, at });
  });
  socket.on('disconnect', () => updateViewers(name));
});

fs.mkdirSync(media, { recursive: true });
db.exec('UPDATE users SET is_live = 0');
const hlsTime = ['1', '2', '4'].includes(process.env.HLS_TIME) ? process.env.HLS_TIME : '2';
const nms = new NodeMediaServer({
  logType: 0,
  rtmp: { port: rtmp, gop_cache: true, ping: 30, ping_timeout: 60 }
});
const streams = new Map();
const recordings = new Map();
function localStream(name) { return 'rtmp://127.0.0.1:' + rtmp + '/live/' + name; }
function snapshot(name, dir) {
  const child = spawn(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', localStream(name),
    '-frames:v', '1', '-vf', 'scale=480:-2', join(dir, 'thumb.jpg')], { stdio: 'ignore', timeout: 8000 });
  child.on('error', () => {});
}
nms.on('prePublish', (id, streamPath, args) => {
  const name = /^\/live\/([a-z0-9_]{3,20})$/.exec(streamPath)?.[1];
  const user = name && channel(name);
  if (!user || args.key !== user.stream_key || streams.has(name) || recordings.has(name)) nms.getSession(id).reject();
});
nms.on('postPublish', (id, streamPath) => {
  const name = streamPath.split('/')[2];
  const dir = join(media, 'live', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir)) {
    if (file === 'index.m3u8' || file.endsWith('.ts')) fs.rmSync(join(dir, file), { force: true });
  }
  const stamp = Date.now();
  const recording = process.env.RECORD_VOD !== 'false';
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', localStream(name),
    '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'hls', '-hls_time', hlsTime,
    '-hls_list_size', '4', '-hls_flags', 'delete_segments+temp_file',
    '-hls_segment_filename', join(dir, stamp + '-%05d.ts'), join(dir, 'index.m3u8')];
  const temp = join(media, name + '-' + stamp + '.partial');
  if (recording) args.push('-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', temp);
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'inherit'] });
  child.stdin.on('error', () => {});
  child.on('error', error => console.error('FFmpeg:', error.message));
  const first = setTimeout(() => snapshot(name, dir), 3000);
  const timer = setInterval(() => snapshot(name, dir), 30000);
  streams.set(name, { id, first, timer, child });
  recordings.set(name, child);
  child.on('close', () => {
    recordings.delete(name);
    if (recording && fs.existsSync(temp)) {
      if (fs.statSync(temp).size > 1024) fs.renameSync(temp, join(dir, stamp + '.mp4'));
      else fs.rmSync(temp, { force: true });
    }
    if (streams.get(name)?.id === id) nms.getSession(id)?.reject();
    else io.emit('live', { username: name, live: false });
  });
  db.prepare('UPDATE users SET is_live = 1 WHERE username = ?').run(name);
  io.emit('live', { username: name, live: true });
});
nms.on('donePublish', (id, streamPath) => {
  const name = streamPath.split('/')[2];
  const active = streams.get(name);
  if (active?.id !== id) return;
  streams.delete(name);
  clearTimeout(active.first);
  clearInterval(active.timer);
  active.child.stdin.end('q\n');
  db.prepare('UPDATE users SET is_live = 0 WHERE username = ?').run(name);
  io.emit('live', { username: name, live: false });
});

if (spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0) nms.run();
else console.warn('FFmpeg no encontrado. Configura FFMPEG_PATH en .env para habilitar OBS.');
server.listen(port, () => console.log('StreamLab · http://localhost:' + port));
