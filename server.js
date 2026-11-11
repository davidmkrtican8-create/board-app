// Доска репетитора: сервер без зависимостей (только встроенный Node.js)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // на своём сервере HOST=127.0.0.1: снаружи доступен только защищённый адрес
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN = process.env.ADMIN_KEY || '';
fs.mkdirSync(DIR, { recursive: true });
const rooms = {};
const ID = /^[\w-]{1,40}$/, RID = /^[a-z0-9]{4,32}$/;
const KINDS = ['pen', 'ers', 'line', 'arrow', 'rect', 'ellipse', 'poly', 'text', 'axes', 'shape'];
// готовые фигуры: плоские и объёмные (школьная программа)
const SHAPES = ['tri', 'rtri', 'square', 'circle', 'para', 'trap', 'rhomb', 'hex', 'cube', 'box', 'prism', 'pyr', 'tetra', 'cyl', 'cone', 'sphere'];
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
      if (kind === 'poly' ? (k.pts.length < 6 || k.pts.length > 40 || k.pts.length % 2) : single ? k.pts.length !== 2 : (kind !== 'pen' && kind !== 'ers' && k.pts.length !== 4)) return false;
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
      if (kind === 'shape') { // готовая фигура в рамке pts
        if (!SHAPES.includes(k.s)) return false;
        o.s = k.s;
      }
      if (['line', 'arrow', 'rect', 'ellipse', 'poly', 'shape'].includes(kind) && Number.isFinite(+k.a) && +k.a) o.a = num(k.a, -7, 7, 0); // поворот фигуры, радианы
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
      t.pts = pts;
      if (op.a !== undefined && Number.isFinite(+op.a)) { if (+op.a) t.a = num(op.a, -7, 7, 0); else delete t.a; } // поворот
      return true;
    }
    case 'imgset': {
      const g = (im[op.page] || {})[op.id];
      if (g) { g.x = num(op.x, -1e6, 1e6, g.x); g.y = num(op.y, -1e6, 1e6, g.y); g.w = num(op.w, 1, 1e5, g.w); g.h = num(op.h, 1, 1e5, g.h); }
      return true;
    }
    case 'erase': { // одно или сразу несколько (ids)
      const ids = Array.isArray(op.ids) ? op.ids.slice(0, 500) : [op.id];
      for (const id of ids) if (typeof id === 'string' && ID.test(id)) { if (st[op.page]) delete st[op.page][id]; if (im[op.page]) delete im[op.page][id]; }
      return true;
    }
    case 'clear': st[op.page] = {}; im[op.page] = {}; return true;
    case 'addPage':
      if (!ID.test(op.id) || s.pages.length >= 200) return false;
      if (!s.pages.some(p => p.id === op.id)) s.pages.push({ id: op.id, title: String(op.title || '').slice(0, 80) });
      return true;
    case 'delPage': { // удалить одну доску ученика (последнюю удалить нельзя)
      const i = s.pages.findIndex(p => p.id === op.id);
      if (i < 0 || s.pages.length <= 1) return false;
      s.pages.splice(i, 1); delete st[op.id]; delete im[op.id];
      return true;
    }
    case 'title': { const p = s.pages.find(p => p.id === op.id); if (p) p.title = String(op.title || '').slice(0, 80); return true; }
    case 'rtc': return ['hello', 'here', 'offer', 'answer', 'ice', 'bye'].includes(op.kind) && RID.test(String(op.from)) && (!op.to || RID.test(String(op.to))) && JSON.stringify(op.data || null).length < 30000;
    case 'cursor': return Number.isFinite(+op.x) && Number.isFinite(+op.y) && String(op.label || '').length <= 40;
    case 'live': return true;
  }
  return false;
}

// ICE-серверы для звонков: публичные STUN, а при заданных CF_TURN_KEY_ID / CF_TURN_API_TOKEN ещё и TURN от Cloudflare
let iceCache = { t: 0, v: null };
// Свой TURN (coturn с use-auth-secret): при заданных TURN_SECRET и TURN_HOST выдаём временные логин/пароль на 12 часов
function ownTurn() {
  const s = process.env.TURN_SECRET, h = process.env.TURN_HOST;
  if (!s || !h) return [];
  const user = (Math.floor(Date.now() / 1000) + 12 * 3600) + ':board';
  const credential = crypto.createHmac('sha1', s).update(user).digest('base64');
  return [{ urls: ['stun:' + h + ':3478'] },
    { urls: ['turn:' + h + ':3478?transport=udp', 'turn:' + h + ':3478?transport=tcp', 'turns:' + h + ':5349?transport=tcp'], username: user, credential }];
}
async function iceServers() {
  const own = ownTurn();
  if (own.length) return own.concat(ICE);
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
// ---------- аккаунты преподавателей ----------
// Владелец (id 'owner', логин admin): пароль из ADMIN_KEY, пока владелец не сменит его в кабинете.
// Остальные преподаватели регистрируются по одноразовой ссылке-приглашению от владельца.
const TF = path.join(DIR, '_teachers.json');
let T = { teachers: [], invites: [] };
try { T = Object.assign(T, JSON.parse(fs.readFileSync(TF, 'utf8'))); } catch (e) {}
const saveT = () => fs.writeFileSync(TF, JSON.stringify(T));
index.students.forEach(s => { if (!s.owner) s.owner = 'owner'; }); // ученики, созданные до аккаунтов, — владельца
const SECRET = (() => {
  const f = path.join(DIR, '_secret');
  try { const s = fs.readFileSync(f); if (s.length >= 32) return s; } catch (e) {}
  const s = crypto.randomBytes(32); fs.writeFileSync(f, s, { mode: 0o600 }); return s;
})();
const LOGIN = /^[a-z0-9._-]{3,32}$/;
const hashPw = (p, salt) => crypto.scryptSync(String(p), salt, 32).toString('hex');
const eq = (a, b) => { const h = x => crypto.createHash('sha256').update(String(x)).digest(); return crypto.timingSafeEqual(h(a), h(b)); };
const teachersOnly = () => T.teachers.filter(t => t.id !== 'owner');
function owner() {
  const o = T.teachers.find(t => t.id === 'owner') || {};
  return { id: 'owner', role: 'owner', login: o.login || 'admin', name: o.name || 'Владелец', salt: o.salt, hash: o.hash, pv: o.pv || 0 };
}
const byId = id => id === 'owner' ? owner() : teachersOnly().find(t => t.id === id);
function byLogin(l) { l = String(l || '').trim().toLowerCase(); return owner().login === l ? owner() : teachersOnly().find(t => t.login === l); }
function checkPw(t, p) {
  if (t.hash) return eq(hashPw(p, t.salt), t.hash);
  return t.id === 'owner' && !!ADMIN && eq(p, ADMIN);
}
const pvOf = t => t.hash ? 'h' + (t.pv || 0) : 'e' + crypto.createHash('sha256').update(ADMIN).digest('hex').slice(0, 8); // смена пароля отзывает старые входы
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(t) { const b = t.id + '.' + (Date.now() + 90 * 864e5); return b + '.' + sign(b + '.' + pvOf(t)); }
function auth(req) {
  const x = req.headers['x-admin']; // вход по старой схеме (пароль владельца в заголовке)
  if (x && ADMIN && !owner().hash && eq(x, ADMIN)) return owner();
  const [id, exp, sig] = String(req.headers['x-token'] || '').split('.');
  if (!id || !exp || !sig || +exp < Date.now()) return null;
  const t = byId(id);
  return t && eq(sig, sign(id + '.' + exp + '.' + pvOf(t))) ? t : null;
}
function setPw(t, p) { // сохранить новый пароль (у владельца — запись 'owner' в _teachers.json)
  let rec = T.teachers.find(x => x.id === t.id);
  if (!rec) { rec = { id: 'owner', login: 'admin', name: 'Владелец' }; T.teachers.push(rec); }
  rec.salt = crypto.randomBytes(16).toString('hex'); rec.hash = hashPw(p, rec.salt); rec.pv = (rec.pv || 0) + 1;
  saveT(); return byId(t.id);
}
const fails = new Map(); // защита от подбора пароля: не больше 10 ошибок за 10 минут с одного адреса
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const recent = req => (fails.get(ipOf(req)) || []).filter(t => Date.now() - t < 6e5);
const limited = req => recent(req).length >= 10;
const fail = req => fails.set(ipOf(req), recent(req).concat(Date.now()));
const validInvite = c => T.invites.find(i => i.code === String(c || '') && !i.used && Date.now() - i.created < 14 * 864e5);
const who = t => ({ name: t.name, login: t.login, role: t.role || 'teacher' });
const randPw = () => crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'board' + Date.now();

function account(req, res, u) { // вход и регистрация (без авторизации)
  if (req.method === 'POST' && u.pathname === '/api/login') return body(req, res, 4000, j => {
    if (limited(req)) { res.writeHead(429); return res.end(); }
    const t = byLogin(j.login);
    if (!t || !checkPw(t, String(j.password || ''))) { fail(req); res.writeHead(401); return res.end(); }
    json(res, Object.assign({ token: makeToken(t) }, who(t)));
  });
  if (req.method === 'GET' && u.pathname === '/api/invite') return json(res, { ok: !!validInvite(u.searchParams.get('code')) });
  if (req.method === 'POST' && u.pathname === '/api/register') return body(req, res, 4000, j => {
    if (limited(req)) { res.writeHead(429); return res.end(); }
    const inv = validInvite(j.code);
    if (!inv) { fail(req); return json(res, { error: 'Приглашение недействительно или уже использовано. Попросите новое.' }); }
    const login = String(j.login || '').trim().toLowerCase(), name = String(j.name || '').trim().slice(0, 60), pw = String(j.password || '');
    if (!name) return json(res, { error: 'Укажите имя' });
    if (!LOGIN.test(login)) return json(res, { error: 'Логин: от 3 до 32 латинских букв или цифр (можно . _ -)' });
    if (byLogin(login)) return json(res, { error: 'Такой логин уже занят, придумайте другой' });
    if (pw.length < 8 || pw.length > 200) return json(res, { error: 'Пароль должен быть не короче 8 символов' });
    const salt = crypto.randomBytes(16).toString('hex');
    const t = { id: 't' + crypto.randomBytes(6).toString('hex'), login, name, salt, hash: hashPw(pw, salt), pv: 0, created: Date.now() };
    T.teachers.push(t); inv.used = Date.now(); inv.usedBy = t.id; saveT();
    json(res, Object.assign({ token: makeToken(t) }, who(t)));
  });
  res.writeHead(404); res.end();
}
const json = (res, v) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
function body(req, res, lim, cb) {
  let b = '';
  req.on('data', c => { b += c; if (b.length > lim) req.destroy(); });
  req.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { res.writeHead(400); return res.end(); } cb(j); });
}
const PAGE = f => (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(path.join(__dirname, f)).pipe(res); };

function dropRoom(id) { // удалить доску ученика целиком
  const r = rooms[id]; if (r) { r.clients.forEach(c => c.end()); delete rooms[id]; }
  if (RID.test(String(id))) fs.unlink(path.join(DIR, id + '.json'), () => {});
}
function admin(req, res, u) {
  const me = auth(req);
  if (!me) { res.writeHead(ADMIN || teachersOnly().length ? 401 : 503); return res.end(); }
  const mine = () => index.students.filter(s => s.owner === me.id);
  const isOwner = me.id === 'owner';
  if (req.method === 'GET' && u.pathname === '/api/admin/me') return json(res, who(me));
  if (req.method === 'GET' && u.pathname === '/api/admin/students') return json(res, mine());
  if (req.method === 'GET' && u.pathname === '/api/admin/backup') {
    const all = {}; mine().forEach(s => { const r = room(s.id); if (r) all[s.id] = r.s; });
    return json(res, { index: { students: mine() }, rooms: all });
  }
  if (req.method === 'GET' && u.pathname === '/api/admin/teachers') {
    if (!isOwner) { res.writeHead(403); return res.end(); }
    return json(res, {
      teachers: teachersOnly().map(t => ({ id: t.id, name: t.name, login: t.login, created: t.created, students: index.students.filter(s => s.owner === t.id).length })),
      invites: T.invites.filter(i => !i.used && Date.now() - i.created < 14 * 864e5).map(i => ({ code: i.code, created: i.created }))
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/admin/op') return body(req, res, 60e6, j => {
    const nm = String(j.name || '').trim().slice(0, 60);
    const own = id => index.students.find(x => x.id === id && x.owner === me.id);
    // --- аккаунт ---
    if (j.t === 'passwd') {
      if (!checkPw(me, String(j.old || ''))) return json(res, { error: 'Текущий пароль указан неверно' });
      const p = String(j.password || '');
      if (p.length < 8 || p.length > 200) return json(res, { error: 'Новый пароль должен быть не короче 8 символов' });
      return json(res, { token: makeToken(setPw(me, p)) });
    }
    if (['invite', 'invite-del', 'teacher-del', 'teacher-reset'].includes(j.t)) {
      if (!isOwner) { res.writeHead(403); return res.end(); }
      if (j.t === 'invite') {
        if (T.invites.filter(i => !i.used).length >= 50) T.invites = T.invites.filter(i => i.used || Date.now() - i.created < 14 * 864e5);
        const code = crypto.randomBytes(12).toString('base64url');
        T.invites.push({ code, created: Date.now() }); saveT(); return json(res, { code });
      }
      if (j.t === 'invite-del') { T.invites = T.invites.filter(i => i.code !== j.code); saveT(); return json(res, { ok: true }); }
      const t = teachersOnly().find(x => x.id === j.id);
      if (!t) return json(res, { error: 'Преподаватель не найден' });
      if (j.t === 'teacher-reset') { const p = randPw(); setPw(t, p); return json(res, { password: p }); }
      index.students.filter(s => s.owner === t.id).forEach(s => dropRoom(s.id)); // teacher-del: вместе с его учениками
      index.students = index.students.filter(s => s.owner !== t.id); saveIndex();
      T.teachers = T.teachers.filter(x => x.id !== t.id); saveT(); return json(res, { ok: true });
    }
    // --- ученики ---
    if (j.t === 'add' && nm) {
      if (mine().length >= 300) return json(res, { error: 'Слишком много учеников' });
      const id = crypto.randomBytes(6).toString('hex');
      index.students.push({ id, name: nm, color: COLORS[mine().length % COLORS.length], owner: me.id });
      saveIndex(); save(room(id));
    } else if (j.t === 'rename' && nm) {
      const s = own(j.id); if (s) { s.name = nm; saveIndex(); }
    } else if (j.t === 'delete') {
      if (own(j.id)) { index.students = index.students.filter(x => x.id !== j.id); saveIndex(); dropRoom(j.id); }
    } else if (j.t === 'restore' && j.data && j.data.index && Array.isArray(j.data.index.students)) {
      const taken = new Set(index.students.filter(s => s.owner !== me.id).map(s => s.id)); // чужих учеников копия не трогает
      const inc = j.data.index.students.filter(s => RID.test(String(s.id)) && !taken.has(s.id))
        .map(s => ({ id: s.id, name: String(s.name || '').slice(0, 60), color: String(s.color || '#888').slice(0, 9), owner: me.id }));
      let todo = inc;
      if (j.merge) { // вернуть только недостающих, существующих не трогать
        const have = new Set(mine().map(x => x.id));
        todo = inc.filter(s => !have.has(s.id));
        index.students = index.students.concat(todo);
      } else index.students = index.students.filter(s => s.owner !== me.id).concat(inc);
      saveIndex();
      todo.forEach(s => {
        const st = (j.data.rooms || {})[s.id];
        if (!st || !Array.isArray(st.pages)) return;
        st.strokes = st.strokes || {}; st.images = st.images || {};
        fs.writeFileSync(path.join(DIR, s.id + '.json'), JSON.stringify(st));
        if (rooms[s.id]) { rooms[s.id].s = st; bcast(rooms[s.id], { t: 'init', s: st, name: s.name }); }
      });
    } else { res.writeHead(400); return res.end(); }
    json(res, mine());
  });
  res.writeHead(404); res.end();
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/admin/')) return admin(req, res, u);
  if (['/api/login', '/api/register', '/api/invite'].includes(u.pathname)) return account(req, res, u);
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
 <div class="card"><h2>Я преподаватель</h2><p>Вход по логину и паролю: там вы создаёте учеников, открываете их доски и добавляете задачи. Аккаунт выдаётся по приглашению от владельца сайта.</p><a class="btn" href="/t">Войти в кабинет</a></div>
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
}).listen(PORT, HOST, () => console.log('Доска запущена: http://localhost:' + PORT + (ADMIN ? '' : ' (ADMIN_KEY не задан: кабинет преподавателя выключен)')));
