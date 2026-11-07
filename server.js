// Общая доска: сервер без зависимостей (только встроенный Node.js)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });
const rooms = {};
const ID = /^[\w-]{1,40}$/;

function room(id) {
  if (rooms[id]) return rooms[id];
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8')); }
  catch (e) { s = { pages: [{ id: 'p1', title: 'Страница 1' }], strokes: {} }; }
  return (rooms[id] = { id, s, clients: new Set(), timer: null });
}
function save(r) {
  clearTimeout(r.timer);
  r.timer = setTimeout(() => fs.writeFile(path.join(DIR, r.id + '.json'), JSON.stringify(r.s), () => {}), 1000);
}
function bcast(r, msg) {
  const d = 'data: ' + JSON.stringify(msg) + '\n\n';
  r.clients.forEach(c => c.write(d));
}
// Проверяет и применяет операцию; возвращает false, если она некорректна
function apply(s, op) {
  const st = s.strokes;
  if (!op || !ID.test(op.page || 'p1')) return false;
  switch (op.t) {
    case 'stroke': {
      const k = op.stroke;
      if (!k || !ID.test(k.id) || !Array.isArray(k.pts) || k.pts.length > 20000 || !/^#[0-9a-f]{3,6}$/i.test(k.c)) return false;
      (st[op.page] = st[op.page] || {})[k.id] = { pts: k.pts.map(Number), c: k.c, w: Math.min(30, Math.max(1, +k.w || 4)) };
      return true;
    }
    case 'erase': if (st[op.page]) delete st[op.page][op.id]; return true;
    case 'clear': st[op.page] = {}; return true;
    case 'addPage':
      if (!ID.test(op.id) || s.pages.length >= 50) return false;
      if (!s.pages.some(p => p.id === op.id)) s.pages.push({ id: op.id, title: String(op.title || '').slice(0, 80) });
      return true;
    case 'title': { const p = s.pages.find(p => p.id === op.id); if (p) p.title = String(op.title || '').slice(0, 80); return true; }
    case 'live': return true; // временный штрих, не сохраняется
  }
  return false;
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/api\/([a-z0-9]{4,32})\/(events|op)$/);
  if (m && m[2] === 'events' && req.method === 'GET') {
    const r = room(m[1]);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.write('data: ' + JSON.stringify({ t: 'init', s: r.s }) + '\n\n');
    r.clients.add(res);
    bcast(r, { t: 'peers', n: r.clients.size });
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); r.clients.delete(res); bcast(r, { t: 'peers', n: r.clients.size }); });
    return;
  }
  if (m && m[2] === 'op' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let op; try { op = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end(); }
      const r = room(m[1]);
      if (!apply(r.s, op)) { res.writeHead(400); return res.end(); }
      bcast(r, op);
      if (op.t !== 'live') save(r);
      res.writeHead(204); res.end();
    });
    return;
  }
  if (u.pathname === '/') {
    res.writeHead(302, { Location: '/b/' + crypto.randomBytes(4).toString('hex') });
    return res.end();
  }
  if (/^\/b\/[a-z0-9]{4,32}$/.test(u.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'board.html')).pipe(res);
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('Доска запущена: http://localhost:' + PORT));
