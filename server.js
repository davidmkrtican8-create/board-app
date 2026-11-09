// Доска репетитора: сервер без зависимостей (только встроенный Node.js)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN = process.env.ADMIN_KEY || '';
fs.mkdirSync(DIR, { recursive: true });
const rooms = {};
const ID = /^[\w-]{1,40}$/, RID = /^[a-z0-9]{4,32}$/;
const KINDS = ['pen', 'line', 'arrow', 'rect', 'ellipse', 'poly', 'text', 'axes'];
const ICE = (() => { try { return JSON.parse(process.env.ICE_SERVERS || ''); } catch (e) { return null; } })()
  || [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const IMG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/;
const COLORS = ['#4caf50', '#1e4f8f', '#e8702a', '#a3238e', '#c4a67a', '#8a9a9f', '#d93025', '#f5c242', '#2a6bb0', '#b0254f', '#8bc34a', '#5b2d90', '#3a9ad9'];
const IDX = path.join(DIR, '_index.json');
let index = { students: [] };
try { index = JSON.parse(fs.readFileSync(IDX, 'utf8')); } catch (e) {}
const saveIndex = () => fs.writeFileSync(IDX, JSON.stringify(index));
const nameOf = id => (index.students.find(s => s.id === id) || {}).name || null;

// Комната = папка одного ученика (внутри неё несколько досок-страниц)
function room(id) {
  if (rooms[id]) return rooms[id];
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8')); }
  catch (e) {
    if (!index.students.some(x => x.id === id)) return null; // неизвестные адреса не создаются
    s = { pages: [{ id: 'p1', title: 'Доска 1' }], strokes: {} };
  }
  s.images = s.images || {};
  return (rooms[id] = { id, s, clients: new Set(), timer: null, call: new Set() });
}
function save(r) {
  clearTimeout(r.timer);
  r.timer = setTimeout(() => fs.writeFile(path.join(DIR, r.id + '.json'), JSON.stringify(r.s), () => {}), 1000);
}
function bcast(r, msg) {
  const d = 'data: ' + JSON.stringify(msg) + '\n\n';
  r.clients.forEach(c => c.write(d));
}
const num = (v, a, b, d) => Math.min(b, Math.max(a, Number.isFinite(+v) ? +v : d));

function apply(s, op) {
  const st = s.strokes, im = s.images;
  if (!op || !ID.test(op.page || 'p1')) return false;
  switch (op.t) {
    case 'stroke': {
      const k = op.stroke;
      if (!k || !ID.test(k.id) || !Array.isArray(k.pts) || k.pts.length > 20000 || !/^#[0-9a-f]{3,6}$/i.test(k.c)) return false;
      const kind = KINDS.includes(k.k) ? k.k : 'pen';
      const single = kind === 'text' || kind === 'axes';
      if (kind === 'poly' ? (k.pts.length < 6 || k.pts.length > 40 || k.pts.length % 2) : single ? k.pts.length !== 2 : (kind !== 'pen' && k.pts.length !== 4)) return false;
      const pts = k.pts.map(Number);
      if (!pts.every(Number.isFinite)) return false;
      const o = { k: kind, pts, c: k.c, w: num(k.w, 0.05, 300, 4) };
      if (kind === 'text') { // напечатанный текст
        if (typeof k.s !== 'string' || !k.s.trim() || k.s.length > 800) return false;
        o.s = k.s; o.w = num(k.w, 6, 300, 36);
      }
      if (kind === 'axes') { // координатная плоскость: «xmin,xmax,ymin,ymax,сетка»
        if (typeof k.s !== 'string' || !/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}(,[01])?$/.test(k.s)) return false;
        o.s = k.s; o.w = num(k.w, 8, 120, 40);
      }
      if (kind === 'pen' && Array.isArray(k.pr) && k.pr.length === pts.length / 2 && k.pr.every(v => typeof v === 'number' && v >= 0 && v <= 1)) o.pr = k.pr.map(v => Math.round(v * 100) / 100); // нажим пера
      (st[op.page] = st[op.page] || {})[k.id] = o;
      return true;
    }
    case 'image': {
      const g = op.img;
      if (!g || !ID.test(g.id) || typeof g.src !== 'string' || g.src.length > 900000 || !IMG.test(g.src)) return false;
      const m = (im[op.page] = im[op.page] || {});
      if (!m[g.id] && Object.keys(m).length >= 40) return false;
      m[g.id] = { src: g.src, x: num(g.x, -1e6, 1e6, 0), y: num(g.y, -1e6, 1e6, 0), w: num(g.w, 1, 1e5, 200), h: num(g.h, 1, 1e5, 200) };
      return true;
    }
    case 'strokeset': { // перенос готового штриха/фигуры (число точек не меняется)
      const t = (st[op.page] || {})[op.id];
      if (!t || !Array.isArray(op.pts)) return false;
      const pts = op.pts.map(Number);
      if (!pts.every(Number.isFinite) || pts.length !== t.pts.length) return false;
      t.pts = pts; return true;
    }
    case 'imgset': {
      const g = (im[op.page] || {})[op.id];
      if (g) { g.x = num(op.x, -1e6, 1e6, g.x); g.y = num(op.y, -1e6, 1e6, g.y); g.w = num(op.w, 1, 1e5, g.w); g.h = num(op.h, 1, 1e5, g.h); }
      return true;
    }
    case 'erase': if (st[op.page]) delete st[op.page][op.id]; if (im[op.page]) delete im[op.page][op.id]; return true;
    case 'clear': st[op.page] = {}; im[op.page] = {}; return true;
    case 'addPage':
      if (!ID.test(op.id) || s.pages.length >= 200) return false;
      if (!s.pages.some(p => p.id === op.id)) s.pages.push({ id: op.id, title: String(op.title || '').slice(0, 80) });
      return true;
    case 'title': { const p = s.pages.find(p => p.id === op.id); if (p) p.title = String(op.title || '').slice(0, 80); return true; }
    case 'rtc': return ['hello', 'here', 'offer', 'answer', 'ice', 'bye'].includes(op.kind) && RID.test(String(op.from)) && (!op.to || RID.test(String(op.to))) && JSON.stringify(op.data || null).length < 30000;
    case 'cursor': return Number.isFinite(+op.x) && Number.isFinite(+op.y) && String(op.label || '').length <= 40;
    case 'live': return true;
  }
  return false;
}

// ICE-серверы для звонков: публичные STUN, а при заданных CF_TURN_KEY_ID / CF_TURN_API_TOKEN ещё и TURN от Cloudflare
let iceCache = { t: 0, v: null };
async function iceServers() {
  const id = process.env.CF_TURN_KEY_ID, tok = process.env.CF_TURN_API_TOKEN;
  if (!id || !tok) return ICE;
  if (iceCache.v && Date.now() - iceCache.t < 3.6e6) return iceCache.v;
  try {
    const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(id) + '/credentials/generate-ice-servers', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    let list = j.iceServers || j; list = Array.isArray(list) ? list : [list];
    list = list.map(x => ({ ...x, urls: [].concat(x.urls).filter(u => !/:53(\?|$)/.test(u)) }));
    iceCache = { t: Date.now(), v: list.concat(ICE) };
    return iceCache.v;
  } catch (e) { console.log('TURN недоступен: ' + e.message); return ICE; }
}
function isAdmin(req) {
  if (!ADMIN) return false;
  const h = x => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(req.headers['x-admin'] || ''), h(ADMIN));
}
const json = (res, v) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
function body(req, res, lim, cb) {
  let b = '';
  req.on('data', c => { b += c; if (b.length > lim) req.destroy(); });
  req.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { res.writeHead(400); return res.end(); } cb(j); });
}
const PAGE = f => (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(path.join(__dirname, f)).pipe(res); };

function admin(req, res, u) {
  if (!ADMIN) { res.writeHead(503); return res.end(); }
  if (!isAdmin(req)) { res.writeHead(401); return res.end(); }
  if (req.method === 'GET' && u.pathname === '/api/admin/students') return json(res, index.students);
  if (req.method === 'GET' && u.pathname === '/api/admin/backup') {
    const all = {}; index.students.forEach(s => { const r = room(s.id); if (r) all[s.id] = r.s; });
    return json(res, { index, rooms: all });
  }
  if (req.method === 'POST' && u.pathname === '/api/admin/op') return body(req, res, 60e6, j => {
    const nm = String(j.name || '').trim().slice(0, 60);
    if (j.t === 'add' && nm) {
      const id = crypto.randomBytes(6).toString('hex');
      index.students.push({ id, name: nm, color: COLORS[index.students.length % COLORS.length] });
      saveIndex(); save(room(id));
    } else if (j.t === 'rename' && nm) {
      const s = index.students.find(x => x.id === j.id); if (s) { s.name = nm; saveIndex(); }
    } else if (j.t === 'delete') {
      index.students = index.students.filter(x => x.id !== j.id); saveIndex();
      const r = rooms[j.id]; if (r) { r.clients.forEach(c => c.end()); delete rooms[j.id]; }
      if (RID.test(String(j.id))) fs.unlink(path.join(DIR, j.id + '.json'), () => {});
    } else if (j.t === 'restore' && j.data && j.data.index && Array.isArray(j.data.index.students)) {
      const inc = j.data.index.students.filter(s => RID.test(String(s.id))).map(s => ({ id: s.id, name: String(s.name || '').slice(0, 60), color: String(s.color || '#888').slice(0, 9) }));
      let todo = inc;
      if (j.merge) { // вернуть только недостающих, существующих не трогать
        const have = new Set(index.students.map(x => x.id));
        todo = inc.filter(s => !have.has(s.id));
        index = { students: index.students.concat(todo) };
      } else index = { students: inc };
      saveIndex();
      todo.forEach(s => {
        const st = (j.data.rooms || {})[s.id];
        if (!st || !Array.isArray(st.pages)) return;
        st.strokes = st.strokes || {}; st.images = st.images || {};
        fs.writeFileSync(path.join(DIR, s.id + '.json'), JSON.stringify(st));
        if (rooms[s.id]) { rooms[s.id].s = st; bcast(rooms[s.id], { t: 'init', s: st, name: s.name }); }
      });
    } else { res.writeHead(400); return res.end(); }
    json(res, index.students);
  });
  res.writeHead(404); res.end();
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/admin/')) return admin(req, res, u);
  const pj = u.pathname.match(/^\/pdfjs\/(pdf(?:\.worker)?\.min\.mjs)$/);
  if (pj) { // pdf.js для просмотра сборников задач в кабинете преподавателя
    const f = path.join(__dirname, pj[1]);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    return fs.createReadStream(f).pipe(res);
  }
  if (u.pathname === '/api/ice') { // ключи TURN выдаём только тем, кто открыл существующую доску
    const rr = String(u.searchParams.get('r') || '');
    if (!RID.test(rr) || !room(rr)) { res.writeHead(404); return res.end(); }
    return iceServers().then(v => json(res, v));
  }
  const m = u.pathname.match(/^\/api\/([a-z0-9]{4,32})\/(events|op)$/);
  if (m) {
    const r = room(m[1]);
    if (!r) { res.writeHead(404); return res.end(); }
    if (m[2] === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      const cid = String(u.searchParams.get('c') || '');
      res.write('data: ' + JSON.stringify({ t: 'init', s: r.s, name: nameOf(r.id), call: [...r.call] }) + '\n\n');
      r.clients.add(res);
      bcast(r, { t: 'peers', n: r.clients.size });
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping); r.clients.delete(res); bcast(r, { t: 'peers', n: r.clients.size });
        if (RID.test(cid) && r.call.delete(cid)) bcast(r, { t: 'rtc', kind: 'bye', from: cid });
      });
      return;
    }
    if (m[2] === 'op' && req.method === 'POST') return body(req, res, 1.2e6, op => {
      if (!apply(r.s, op)) { res.writeHead(400); return res.end(); }
      if (op.t === 'rtc') { if (op.kind === 'hello') r.call.add(op.from); if (op.kind === 'bye') r.call.delete(op.from); }
      bcast(r, op);
      if (op.t !== 'live' && op.t !== 'rtc' && op.t !== 'cursor') save(r);
      res.writeHead(204); res.end();
    });
  }
  if (u.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); } // для сервиса, который не даёт сайту «засыпать»
  if (u.pathname === '/icon.png') {
    const f = path.join(__dirname, 'icon.png');
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return fs.createReadStream(f).pipe(res);
  }
  const mf = u.pathname.match(/^\/b\/([a-z0-9]{4,32})\/manifest\.webmanifest$/);
  if (mf) { // «установить как приложение»: на телефоне открывается без панелей браузера
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    return res.end(JSON.stringify({ name: 'Доска', short_name: 'Доска', start_url: '/b/' + mf[1], scope: '/', display: 'fullscreen', display_override: ['fullscreen', 'standalone'], background_color: '#f4f1fa', theme_color: '#6a3fc4', icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }] }));
  }
  if (u.pathname === '/t') return PAGE('admin.html')(req, res);
  if (u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Доска репетитора</title>
<style>
:root{--bg:#f4f1fa;--panel:#fff;--tx:#201c2b;--mut:#6b6580;--ac:#6a3fc4;--bd:#ddd6ee}
@media (prefers-color-scheme:dark){:root{--bg:#17141f;--panel:#221e2e;--tx:#ece8f5;--mut:#9a93b0;--ac:#a98bf0;--bd:#3a3450}}
body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;justify-content:center}
main{width:100%;max-width:520px;padding:8vh 18px}
h1{margin:0 0 6px;font-size:26px}.sub{color:var(--mut);margin:0 0 22px}
.card{background:var(--panel);border:1px solid var(--bd);border-radius:14px;padding:18px 20px;margin-bottom:14px}
.card h2{margin:0 0 6px;font-size:18px}.card p{margin:0 0 12px;color:var(--mut)}
a.btn{display:inline-block;padding:11px 18px;border-radius:10px;background:var(--ac);color:#fff;text-decoration:none;font-weight:600}
</style>
<main>
 <h1>Доска репетитора</h1>
 <p class="sub">Общая доска для занятий: преподаватель и ученик рисуют вместе.</p>
 <div class="card"><h2>Я ученик</h2><p>Откройте личную ссылку на свою доску, которую прислал преподаватель (она выглядит как адрес этого сайта и набор букв и цифр в конце). Без неё зайти на доску нельзя. Если ссылки нет, напишите преподавателю.</p></div>
 <div class="card"><h2>Я преподаватель</h2><p>Вход по вашему паролю: там вы создаёте учеников, открываете их доски и добавляете задачи.</p><a class="btn" href="/t">Войти в кабинет</a></div>
</main></html>`);
  }
  const b = u.pathname.match(/^\/b\/([a-z0-9]{4,32})$/);
  if (b) {
    if (!room(b[1])) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><body style="font:16px system-ui;max-width:420px;margin:12vh auto;padding:0 18px"><h2>Доска пока недоступна</h2><p>Сайт только что проснулся или обновился. Попросите преподавателя открыть свой кабинет: он вернёт доски. Эта страница обновится сама через несколько секунд.</p>');
    }
    return PAGE('board.html')(req, res);
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('Доска запущена: http://localhost:' + PORT + (ADMIN ? '' : ' (ADMIN_KEY не задан: кабинет преподавателя выключен)')));
