// Доска репетитора: сервер без зависимостей (только встроенный Node.js)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // на своём сервере HOST=127.0.0.1: снаружи доступен только защищённый адрес
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN = process.env.ADMIN_KEY || '';
fs.mkdirSync(DIR, { recursive: true });
const rooms = {};
const ID = /^[\w-]{1,40}$/, RID = /^[a-z0-9]{4,32}$/;
const KINDS = ['pen', 'ers', 'line', 'arrow', 'rect', 'ellipse', 'poly', 'text', 'axes', 'shape', 'plot', 'solid', 'hl'];
const SOLIDS = ['cube', 'box', 'prism', 'pyr', 'tetra', 'cyl', 'cone', 'sphere']; // вращаемые 3D-тела
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
// группы: запись в том же списке, что и ученики, с type:'group' и members — у группы свои общие доски, у участников свои кабинеты
const isGroup = id => (index.students.find(s => s.id === id) || {}).type === 'group';
const membersOf = id => { const g = index.students.find(s => s.id === id); return g && g.type === 'group' ? (g.members || []).filter(m => index.students.some(s => s.id === m && s.type !== 'group')) : []; };
const groupsOf = sid => index.students.filter(g => g.type === 'group' && (g.members || []).includes(sid));

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
  for (const pg in s.strokes || {}) delete s.strokes[pg].undefined; // объекты без номера (старая ошибка правки после перезагрузки)
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
      if (!k || typeof k.id !== 'string' || !ID.test(k.id) || !Array.isArray(k.pts) || k.pts.length > 20000 || !/^#[0-9a-f]{3,6}$/i.test(k.c)) return false;
      const kind = KINDS.includes(k.k) ? k.k : 'pen';
      const single = kind === 'text' || kind === 'axes' || kind === 'plot';
      if (kind === 'poly' ? (k.pts.length < 6 || k.pts.length > 40 || k.pts.length % 2) : single ? k.pts.length !== 2 : (kind !== 'pen' && kind !== 'ers' && kind !== 'hl' && k.pts.length !== 4)) return false;
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
      if (kind === 'plot' || kind === 'solid') { // параметры в JSON: график {ax, f, p} или 3D-тело {t, y, p, l}
        if (typeof k.s !== 'string' || k.s.length > 600) return false;
        let j; try { j = JSON.parse(k.s); } catch (e) { return false; }
        if (!j || typeof j !== 'object') return false;
        if (kind === 'plot' && (typeof j.f !== 'string' || j.f.length > 200 || !ID.test(String(j.ax || '')) || !j.p || typeof j.p !== 'object'
          || Object.keys(j.p).length > 8 || !Object.entries(j.p).every(([a, v]) => /^[a-zа-яё]$/i.test(a) && Number.isFinite(+v)))) return false;
        if (kind === 'solid' && (!SOLIDS.includes(j.t) || !Number.isFinite(+j.y) || !Number.isFinite(+j.p))) return false;
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
    case 'laser': return Array.isArray(op.pts) && op.pts.length <= 400 && op.pts.every(v => Number.isFinite(+v)); // указка: не сохраняется
    case 'view': return !!op.stop || ['x', 'y', 'w', 'h'].every(k => Number.isFinite(+op[k])); // «следуй за мной»: не сохраняется
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
let logMin = 0, logN = 0;
function body(req, res, lim, cb) {
  let b = '';
  req.on('data', c => { b += c; if (b.length > lim) req.destroy(); });
  req.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { res.writeHead(400); return res.end(); } cb(j); });
}
// страницы и скрипты отдаём сжатыми (в 4–5 раз меньше) и с меткой версии: браузер берёт их из своего кэша, пока файл не обновился
const GZC = {};
function sendFile(req, res, f, type, cc) {
  let st; try { st = fs.statSync(f); } catch (e) { res.writeHead(404); return res.end(); }
  let c = GZC[f];
  if (!c || c.m !== st.mtimeMs) {
    const raw = fs.readFileSync(f);
    c = GZC[f] = { m: st.mtimeMs, raw, gz: zlib.gzipSync(raw, { level: 9 }), br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 } }), tag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 16) + '"' };
  }
  const h = { 'Content-Type': type, 'Cache-Control': cc || 'no-cache', 'ETag': c.tag, 'Vary': 'Accept-Encoding' };
  if (req.headers['if-none-match'] === c.tag) { res.writeHead(304, h); return res.end(); }
  const ae = String(req.headers['accept-encoding'] || ''), body = /\bbr\b/.test(ae) ? (h['Content-Encoding'] = 'br', c.br) : /\bgzip\b/.test(ae) ? (h['Content-Encoding'] = 'gzip', c.gz) : c.raw;
  h['Content-Length'] = body.length; res.writeHead(200, h); res.end(req.method === 'HEAD' ? undefined : body);
}
const PAGE = f => (req, res) => sendFile(req, res, path.join(__dirname, f), 'text/html; charset=utf-8');

// ---------- домашние задания ----------
// у каждого ученика свой файл hw/<id>.json (только текст), картинки задач и фото тетрадей — отдельными файлами в hw/<id>/
const HWD = path.join(DIR, 'hw');
try { fs.mkdirSync(HWD, { recursive: true }); } catch (e) {}
const hwc = {};
function hwOf(sid) {
  if (hwc[sid]) return hwc[sid];
  let v; try { v = JSON.parse(fs.readFileSync(path.join(HWD, sid + '.json'), 'utf8')); } catch (e) { v = { list: [] }; }
  return (hwc[sid] = v);
}
const hwSave = sid => fs.writeFileSync(path.join(HWD, sid + '.json'), JSON.stringify(hwc[sid]));
const HIMG = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+\/=]+)$/, HNAME = /^[a-f0-9]{16}\.(jpg|png|webp)$/;
function hwImg(sid, src, lim) { // сохранить картинку, вернуть имя файла
  if (typeof src !== 'string' || src.length > lim) return null;
  const m = HIMG.exec(src); if (!m) return null;
  const n = crypto.randomBytes(8).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.mkdirSync(path.join(HWD, sid), { recursive: true });
  fs.writeFileSync(path.join(HWD, sid, n), Buffer.from(m[2], 'base64'));
  return n;
}
const hwRm = (sid, n) => { if (HNAME.test(String(n))) fs.unlink(path.join(HWD, sid, n), () => {}); };
const norm = a => String(a == null ? '' : a).toLowerCase().replace(/\s+/g, '').replace(/,/g, '.').replace(/[−–—]/g, '-');
const right = (ans, a) => !!norm(a) && String(ans).split(/[;|]/).some(x => norm(x) && norm(x) === norm(a)); // в ответе можно указать варианты через ;
// «Работа над ошибками»: неверно решённые задачи копятся в H.mis и через неделю сами предлагаются в новую домашку
const REP_DAYS = 7, REP_MAX = 3, REPF = path.join(HWD, '_rep.json');
let REPOFF = {}; try { REPOFF = JSON.parse(fs.readFileSync(REPF, 'utf8')); } catch (e) {}
const repOn = tid => !REPOFF[tid];
function hwCopy(sid, n) { // копия картинки под новым именем (у каждой домашки и у копилки ошибок — свои файлы)
  if (!HNAME.test(String(n))) return null;
  const m = crypto.randomBytes(8).toString('hex') + n.slice(n.lastIndexOf('.'));
  try { fs.copyFileSync(path.join(HWD, sid, n), path.join(HWD, sid, m)); return m; } catch (e) { return null; }
}
function hwCopyTo(from, n, to) { // картинку задачи группы — в папку участника
  if (!HNAME.test(String(n))) return null;
  const m = crypto.randomBytes(8).toString('hex') + n.slice(n.lastIndexOf('.'));
  try { fs.mkdirSync(path.join(HWD, to), { recursive: true }); fs.copyFileSync(path.join(HWD, from, n), path.join(HWD, to, m)); return m; } catch (e) { return null; }
}
const repDue = H => (H.mis || []).filter(x => !x.out && Date.now() - x.at >= REP_DAYS * 864e5).sort((a, b) => a.at - b.at).slice(0, REP_MAX);
function repCheck(sid, H, h) { // после проверки: ошибки — в копилку, исправленные — из копилки
  H.mis = H.mis || []; H.fixed = H.fixed || 0;
  for (const t of h.tasks) {
    const m = h.marks[t.id] !== undefined ? h.marks[t.id] : h.auto[t.id];
    if (t.rep) {
      const x = H.mis.find(y => y.id === t.rep);
      if (!x || t.repDone) continue;
      if (m === 1) { hwRm(sid, x.img); H.mis = H.mis.filter(y => y !== x); H.fixed++; t.repDone = 1; }
      else { x.out = null; if (m === 0) { x.at = Date.now(); x.n = (x.n || 1) + 1; t.repDone = 1; } }
    } else {
      const src = h.id + ':' + t.id, x = H.mis.find(y => y.src === src);
      if (m === 0 && !x && H.mis.length < 200) H.mis.push({ id: crypto.randomBytes(4).toString('hex'), src, img: t.img ? hwCopy(sid, t.img) : null, w: t.w, h: t.h, text: t.text, num: t.num, ans: t.ans, at: Date.now(), n: 1, out: null });
      else if (m === 1 && x && !x.out) { hwRm(sid, x.img); H.mis = H.mis.filter(y => y !== x); } // оценку исправили на «верно»
    }
  }
}
const hwPending = sid => hwOf(sid).list.filter(h => h.st === 'sent').length;
function hwPublic(h) { // что видит ученик: правильные ответы — только после проверки
  const done = h.st === 'checked';
  return {
    id: h.id, title: h.title, due: h.due, created: h.created, st: h.st, sentAt: h.sentAt, checkedAt: h.checkedAt,
    comment: done ? h.comment : '', photos: h.photos, board: h.board, answers: h.answers,
    auto: h.st === 'new' ? {} : h.auto, marks: done ? h.marks : {},
    tasks: h.tasks.map(t => ({ id: t.id, img: t.img, w: t.w, h: t.h, text: t.text, num: t.num, rep: t.rep ? 1 : 0, short: !!t.ans, ans: done ? t.ans : undefined }))
  };
}
function hwBoard(sid, h) { // «Решать на доске»: отдельная доска с задачами и местом под решение
  const r = room(sid); if (!r) return null;
  const pid = 'h' + h.id;
  if (r.s.pages.some(p => p.id === pid)) return pid;
  const PH = 1414, PS = 1442, ops = [{ t: 'addPage', id: pid, title: ('ДЗ: ' + h.title).slice(0, 80) }];
  let y = 40;
  const fit = hh => { const k = Math.floor(y / PS); if (y + hh > k * PS + PH - 20) y = (k + 1) * PS + 40; };
  h.tasks.forEach((t, i) => {
    const label = 'Задача ' + (i + 1) + (t.num ? ' (№' + t.num + ')' : '') + (t.rep ? ' — работа над ошибками' : '');
    const words = String(t.text || '').split(/\s+/).filter(Boolean), lines = [label];
    let ln = '';
    for (const w of words) { if ((ln + ' ' + w).trim().length > 58) { lines.push(ln); ln = w; } else ln = (ln + ' ' + w).trim(); }
    if (ln) lines.push(ln);
    const th = lines.length * 26 * 1.25;
    let src = null, dw = 880, dh = 0;
    if (t.img) {
      try { const b = fs.readFileSync(path.join(HWD, sid, t.img)); src = 'data:image/' + (t.img.endsWith('png') ? 'png' : t.img.endsWith('webp') ? 'webp' : 'jpeg') + ';base64,' + b.toString('base64'); } catch (e) {}
      if (src && src.length > 900000) src = null;
      if (src) { dh = dw * (t.h || 1) / (t.w || 1); if (dh > PH * 0.6) { dh = PH * 0.6; dw = dh * (t.w || 1) / (t.h || 1); } }
    }
    fit(th + 12 + dh); // подпись и условие — на одном листе
    ops.push({ t: 'stroke', page: pid, stroke: { id: 'h' + t.id + 't', k: 'text', pts: [60, y], c: '#201c2b', w: 26, s: lines.join('\n').slice(0, 800) } });
    y += th + 12;
    if (src) {
      ops.push({ t: 'image', page: pid, img: { id: 'h' + t.id + 'i', src, x: Math.round((1000 - dw) / 2), y: Math.round(y), w: Math.round(dw), h: Math.round(dh) } });
      y += dh;
    }
    y += 380; // место под решение
  });
  for (const op of ops) if (apply(r.s, op)) bcast(r, Object.assign({ from: 'srv' }, op));
  save(r);
  return pid;
}
// ---------- Telegram-бот: домашка, напоминания и конспекты ученику и родителям ----------
// один бот на весь сайт; токен вводит владелец в кабинете («Telegram»), хранится в _tg.json
const https = require('https');
const TGF = path.join(DIR, '_tg.json');
let TG = { token: '', bot: '', site: '', offset: 0, subs: {}, tsubs: {} };
try { TG = Object.assign(TG, JSON.parse(fs.readFileSync(TGF, 'utf8'))); } catch (e) {}
const saveTG = () => fs.writeFileSync(TGF, JSON.stringify(TG));
const siteOf = req => (String(req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http') + '://' + req.headers.host;
function tgCall(method, params, timeout, token) {
  return new Promise((ok, bad) => {
    const b = Buffer.from(JSON.stringify(params || {}));
    const rq = https.request({ host: 'api.telegram.org', path: '/bot' + (token || TG.token) + '/' + method, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': b.length }, timeout: timeout || 20000 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { ok(JSON.parse(d)); } catch (e) { bad(e); } });
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.on('error', bad); rq.end(b);
  });
}
function tgDoc(chat, buf, fname, caption) { // отправить файл (PDF конспекта)
  return new Promise((ok, bad) => {
    const bd = '----b' + crypto.randomBytes(8).toString('hex'), parts = [];
    const field = (n, v) => parts.push(Buffer.from('--' + bd + '\r\nContent-Disposition: form-data; name="' + n + '"\r\n\r\n' + v + '\r\n'));
    field('chat_id', String(chat)); if (caption) field('caption', caption.slice(0, 1000));
    parts.push(Buffer.from('--' + bd + '\r\nContent-Disposition: form-data; name="document"; filename="' + encodeURIComponent(fname) + '"\r\nContent-Type: application/pdf\r\n\r\n'), buf, Buffer.from('\r\n--' + bd + '--\r\n'));
    const body = Buffer.concat(parts);
    const rq = https.request({ host: 'api.telegram.org', path: '/bot' + TG.token + '/sendDocument', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + bd, 'Content-Length': body.length }, timeout: 60000 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { ok(JSON.parse(d)); } catch (e) { bad(e); } });
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.on('error', bad); rq.end(body);
  });
}
// Связь сервера (Москва) с Telegram то и дело обрывается. Поэтому сообщения идут через очередь (она хранится в _tg.json):
// бот повторяет отправку, пока сообщение не дойдёт (до двух суток), — уведомление не пропадёт.
let tgBusy = false;
function tgSay(chat, text) {
  if (!TG.token || !text) return Promise.resolve(null);
  TG.out = TG.out || []; TG.out.push({ chat, text, t0: Date.now(), n: 0, next: 0 }); saveTG();
  setImmediate(tgFlush); return Promise.resolve({ ok: true, queued: true });
}
async function tgFlush() {
  if (tgBusy || !TG.token || !(TG.out || []).length) return; tgBusy = true;
  try {
    let ch = false;
    for (const m of TG.out.slice()) {
      if (m.next > Date.now()) continue;
      let r = null; try { r = await tgCall('sendMessage', { chat_id: m.chat, text: m.text, disable_web_page_preview: true }, 12000); } catch (e) {}
      if (r && (r.ok || r.error_code === 400 || r.error_code === 403)) { // доставлено, или такого чата нет / бот заблокирован — больше не пытаемся
        if (r.error_code === 403) tgDrop(m.chat);
        TG.out = TG.out.filter(x => x !== m); ch = true;
      } else {
        m.n++; m.next = Date.now() + Math.min(15 * 60e3, 20e3 * 2 ** Math.min(m.n, 6)); ch = true;
        if (Date.now() - m.t0 > 48 * 3600e3) { TG.out = TG.out.filter(x => x !== m); console.log('tg: не доставлено за 2 суток', m.chat); }
      }
    }
    if (ch) saveTG();
  } finally { tgBusy = false; }
}
setInterval(() => tgFlush().catch(() => {}), 15000);
// отправить сразу, с повторами (для конспекта по кнопке — преподаватель ждёт ответа)
async function tgRetry(fn, tries) {
  for (let i = 0; i < (tries || 4); i++) { try { const r = await fn(); if (r && (r.ok || r.error_code === 400 || r.error_code === 403)) return r; } catch (e) {} await new Promise(ok => setTimeout(ok, 1500 * (i + 1))); }
  return null;
}
function tgDrop(chat) { // человек заблокировал бота — больше не пишем
  for (const k in TG.subs) TG.subs[k] = TG.subs[k].filter(x => x.chat !== chat);
  for (const k in TG.tsubs) TG.tsubs[k] = TG.tsubs[k].filter(x => x !== chat);
  saveTG();
}
const tCode = tid => 't' + tid + '_' + sign('tg' + tid).slice(0, 12).replace(/[^A-Za-z0-9]/g, 'x');
const tgLink = code => TG.bot ? 'https://t.me/' + TG.bot + '?start=' + code : '';
// написать ученику и его родителям; f(кто) возвращает текст: 's' — ученику, 'p' — родителю
function subsOf(id) { // кому писать: ученик и родители; для группы — все участники и их родители
  if (!isGroup(id)) return TG.subs[id] || [];
  const seen = new Set(), out = []; membersOf(id).forEach(m => (TG.subs[m] || []).forEach(x => { if (!seen.has(x.chat)) { seen.add(x.chat); out.push(x); } })); return out;
}
function tgStudent(sid, f) { (TG.subs[sid] || []).forEach(x => { const t = f(x.who); if (t) tgSay(x.chat, t); }); }
function tgTeacher(tid, text) { (TG.tsubs[tid] || []).forEach(c => tgSay(c, text)); }
function tgOnMessage(m) {
  if (!m || !m.chat || m.chat.type !== 'private') return;
  const chat = m.chat.id, text = String(m.text || '').trim(), who = [m.from && m.from.first_name, m.from && m.from.last_name].filter(Boolean).join(' ').slice(0, 60);
  const st = text.match(/^\/start(?:\s+(\S+))?/);
  if (text === '/stop') { tgDrop(chat); return tgSay(chat, 'Готово, больше не буду писать. Подключиться снова можно по ссылке из кабинета.'); }
  if (st && st[1]) {
    const c = st[1], s = index.students.find(x => x.id === c.slice(1));
    if ((c[0] === 's' || c[0] === 'p') && s) {
      const L = (TG.subs[s.id] = (TG.subs[s.id] || []).filter(x => x.chat !== chat));
      if (L.length >= 10) L.shift();
      L.push({ chat, who: c[0], name: who }); saveTG();
      return tgSay(chat, c[0] === 's'
        ? 'Готово, ' + s.name + '! Сюда будут приходить домашки, напоминания о сроках и результаты проверки.\nКабинет: ' + TG.site + '/s/' + s.id + '\nОтключить: /stop'
        : 'Готово! Сюда будут приходить новости об уроках и домашках ученика: ' + s.name + '.\nОтключить: /stop');
    }
    const t = [owner(), ...teachersOnly()].find(x => tCode(x.id) === c);
    if (t) {
      const L = (TG.tsubs[t.id] = (TG.tsubs[t.id] || []).filter(x => x !== chat)); L.push(chat); saveTG();
      return tgSay(chat, 'Готово, ' + t.name + '! Буду сообщать, когда ученики сдают домашку.\nОтключить: /stop');
    }
  }
  tgSay(chat, 'Это бот УчиДоски. Чтобы подключиться, откройте ссылку из кабинета ученика или ту, что прислал преподаватель.');
}
let tgPolling = false;
async function tgPoll() {
  if (tgPolling) return; tgPolling = true;
  for (;;) {
    if (!TG.token) { await new Promise(r => setTimeout(r, 10000)); continue; }
    try {
      const tok = TG.token, r = await tgCall('getUpdates', { offset: TG.offset, timeout: 50, allowed_updates: ['message'] }, 65000);
      if (tok !== TG.token) continue;
      if (!r.ok) { await new Promise(x => setTimeout(x, 15000)); continue; }
      for (const u of r.result) { TG.offset = u.update_id + 1; try { tgOnMessage(u.message); } catch (e) {} }
      if (r.result.length) saveTG();
    } catch (e) { await new Promise(x => setTimeout(x, 5000)); }
  }
}
tgPoll();
const dmy = t => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
setInterval(() => { // напоминание о сроке: накануне, с 15 до 21 по Москве
  const hr = (new Date().getUTCHours() + 3) % 24;
  if (!TG.token || hr < 15 || hr >= 21) return;
  for (const sid in TG.subs) {
    if (!TG.subs[sid].length || !index.students.some(x => x.id === sid)) continue;
    const H = hwOf(sid); let ch = false;
    for (const h of H.list) {
      if (h.st !== 'new' || !h.due || h.rem || h.due - Date.now() > 30 * 3600e3 || h.due < Date.now()) continue;
      h.rem = 1; ch = true;
      tgStudent(sid, w => w === 's' ? '⏰ Напоминание: домашку «' + h.title + '» нужно сдать до ' + dmy(h.due) + '. Если уже решил — не забудь нажать «Сдать на проверку».\n' + TG.site + '/s/' + sid + '?hw=' + h.id : null);
    }
    if (ch) hwSave(sid);
  }
}, 30 * 60e3);
// ---------- вечерний конспект: PDF досок, которые меняли на уроке ----------
// снимок присылает браузер преподавателя (POST /api/<id>/snap), вечером бот рассылает их ученику и родителям
const SND = path.join(DIR, 'snap'), SNM = path.join(SND, '_meta.json');
try { fs.mkdirSync(SND, { recursive: true }); } catch (e) {}
let SN = {}; try { SN = JSON.parse(fs.readFileSync(SNM, 'utf8')); } catch (e) {}
const saveSN = () => fs.writeFileSync(SNM, JSON.stringify(SN));
const mskDay = t => new Date((t || Date.now()) + 3 * 3600e3).toISOString().slice(0, 10);
function snapPost(req, res, sid) {
  const me = auth(req), s = index.students.find(x => x.id === sid);
  if (!me || !s || s.owner !== me.id) { res.writeHead(403); return res.end(); }
  body(req, res, 25e6, j => {
    const pg = String(j.page || '');
    if (!ID.test(pg) || typeof j.pdf !== 'string' || j.pdf.length > 24e6) { res.writeHead(400); return res.end(); }
    const buf = Buffer.from(j.pdf, 'base64');
    if (buf.slice(0, 5).toString() !== '%PDF-') { res.writeHead(400); return res.end(); }
    fs.mkdirSync(path.join(SND, sid), { recursive: true });
    fs.writeFileSync(path.join(SND, sid, pg + '.pdf'), buf);
    const m = (SN[sid] = SN[sid] || {}), old = m[pg] || {};
    m[pg] = { t: Date.now(), day: mskDay(), title: String(j.title || 'Доска').slice(0, 80), sent: old.day === mskDay() ? old.sent || 0 : 0, manual: old.day === mskDay() ? old.manual : undefined };
    saveSN(); res.writeHead(204); res.end();
  });
}
let snapRunning = false;
async function snapSend() {
  // с 21:00 по Москве; все доски ученика уходят вместе — когда ни одну из них не меняли уже 30 минут
  // (урок 21:00–22:00 на двух досках: обе придут около 22:30). Урок, закончившийся после полуночи, уходит ночью же.
  const hr = (new Date().getUTCHours() + 3) % 24;
  if (snapRunning) return; snapRunning = true;
  try {
    const today = mskDay();
    for (const sid of Object.keys(SN)) {
      const s = index.students.find(x => x.id === sid), m = SN[sid];
      if (!s) { delete SN[sid]; fs.rm(path.join(SND, sid), { recursive: true, force: true }, () => {}); continue; }
      const done = e => e.sent >= e.t || e.manual === e.day; // уже отправлено (в том числе вручную кнопкой «📨 Конспект»)
      const due = Object.keys(m).filter(pg => !done(m[pg]));
      for (const pg of Object.keys(m)) if (m[pg].day !== today && done(m[pg])) { delete m[pg]; fs.unlink(path.join(SND, sid, pg + '.pdf'), () => {}); } // вчерашнее отправленное — убираем
      if (!due.length) { if (!Object.keys(m).length) delete SN[sid]; continue; }
      const last = Math.max(...due.map(pg => m[pg].t)), old = due.some(pg => m[pg].day !== today);
      if (Date.now() - last < 30 * 60e3 || (hr < 21 && !old)) continue;
      const L = TG.token && !(TG.noAuto || {})[s.owner] ? subsOf(sid) : [];
      for (const pg of due.sort((a, b) => m[a].t - m[b].t)) {
        const e = m[pg]; let buf = null; try { buf = fs.readFileSync(path.join(SND, sid, pg + '.pdf')); } catch (er) {}
        let miss = 0; e.got = e.got || []; e.tries = (e.tries || 0) + 1;
        if (buf) for (const x of L) {
          if (e.got.includes(x.chat)) continue;
          const cap = (x.who === 'p' ? '📝 ' + s.name + ' — конспект урока ' : '📝 Конспект урока ') + dmy(e.t) + ': «' + e.title + '»';
          const r = await tgRetry(() => tgDoc(x.chat, buf, (s.name + ' — ' + e.title + '.pdf').replace(/[\\/:*?"<>|]/g, '_'), cap), 3);
          if (r) e.got.push(x.chat); else miss++;
        }
        if (!miss || e.tries >= 12) e.sent = Date.now(); // не дошло — попробуем снова через 10 минут (но не больше 2 часов)
      }
    }
    saveSN();
  } finally { snapRunning = false; }
}
setInterval(() => { snapSend().catch(() => {}); }, 10 * 60e3);
function tgAdmin(req, res, u, me) { // /api/admin/tg…
  const isOwner = me.id === 'owner', own = id => index.students.find(x => x.id === id && x.owner === me.id);
  if (req.headers.host) { const s = siteOf(req); if (TG.site !== s && TG.token) { TG.site = s; saveTG(); } }
  if (req.method === 'GET' && u.pathname === '/api/admin/tg') return json(res, { on: !!TG.token, bot: TG.bot, owner: isOwner, me: (TG.tsubs[me.id] || []).length, link: tgLink(tCode(me.id)), auto: !(TG.noAuto || {})[me.id] });
  if (req.method === 'GET' && u.pathname === '/api/admin/tg-student') {
    const sid = String(u.searchParams.get('s') || ''); if (!own(sid)) { res.writeHead(404); return res.end(); }
    return json(res, { on: !!TG.token, group: isGroup(sid), s: tgLink('s' + sid), p: tgLink('p' + sid), subs: subsOf(sid).map(x => ({ who: x.who, name: x.name })) });
  }
  if (req.method === 'POST' && u.pathname === '/api/admin/tg') return body(req, res, 30e6, j => tgPost(req, res, j, me, isOwner, own).catch(() => { try { res.writeHead(500); res.end(); } catch (e) {} }));
  res.writeHead(404); res.end();
}
async function tgPost(req, res, j, me, isOwner, own) {
    if (j.t === 'token') {
      if (!isOwner) { res.writeHead(403); return res.end(); }
      const tok = String(j.token || '').trim();
      if (!tok) { TG.token = ''; TG.bot = ''; saveTG(); return json(res, { ok: true }); }
      if (!/^\d+:[\w-]{30,}$/.test(tok)) return json(res, { error: 'Это не похоже на токен бота. Скопируйте его из сообщения @BotFather целиком.' });
      let r = null; try { r = await tgCall('getMe', {}, 15000, tok); } catch (e) {}
      if (!r || !r.ok) return json(res, { error: 'Telegram не принял этот токен. Проверьте, что скопировали его полностью.' });
      TG.token = tok; TG.bot = r.result.username; TG.offset = 0; TG.site = siteOf(req); saveTG();
      return json(res, { ok: true, bot: TG.bot });
    }
    if (j.t === 'auto') { TG.noAuto = TG.noAuto || {}; if (j.on) delete TG.noAuto[me.id]; else TG.noAuto[me.id] = true; saveTG(); return json(res, { ok: true }); }
    if (j.t === 'send') { // конспект урока
      const s = own(String(j.s || '')); if (!s) { res.writeHead(404); return res.end(); }
      if (!TG.token) return json(res, { error: 'Telegram-бот не подключён' });
      const L = subsOf(s.id); if (!L.length) return json(res, { error: isGroup(s.id) ? 'Никто из группы ещё не подключил Telegram' : 'Ни ученик, ни родители ещё не подключили Telegram' });
      const text = String(j.text || '').trim().slice(0, 3500);
      let pdf = null; if (typeof j.pdf === 'string' && j.pdf.length < 28e6) pdf = Buffer.from(j.pdf, 'base64');
      const fname = String(j.fname || 'Конспект.pdf').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 100);
      let n = 0;
      for (const x of L) {
        try {
          if (text) { const r = await tgRetry(() => tgCall('sendMessage', { chat_id: x.chat, text, disable_web_page_preview: true }, 12000)); if (!r) { tgSay(x.chat, text); } }
          if (pdf) { const r = await tgRetry(() => tgDoc(x.chat, pdf, fname, '')); if (r && r.ok) n++; } else n++;
        } catch (e) {}
      }
      if (n && pdf && ID.test(String(j.page || ''))) { // эту доску уже отправили вручную — вечером повторно не шлём
        const m = (SN[s.id] = SN[s.id] || {}), pg = String(j.page), today = mskDay();
        m[pg] = Object.assign(m[pg] && m[pg].day === today ? m[pg] : { t: 0, day: today, title: 'Доска', sent: 0 }, { manual: today }); saveSN();
      }
      return json(res, n ? { sent: n } : { error: 'Не получилось отправить. Попробуйте ещё раз.' });
    }
    res.writeHead(400); res.end();
}
function hwTeacher(req, res, u, me) { // /api/admin/hw…
  const own = id => index.students.find(x => x.id === id && x.owner === me.id);
  if (req.method === 'GET' && u.pathname === '/api/admin/hw-pending') {
    const o = {}; index.students.filter(s => s.owner === me.id).forEach(s => { const n = s.type === 'group' ? membersOf(s.id).reduce((a, m) => a + hwPending(m), 0) : hwPending(s.id); if (n) o[s.id] = n; });
    return json(res, o);
  }
  if (req.method === 'GET' && u.pathname === '/api/admin/hw-rep') {
    const sid = String(u.searchParams.get('s') || '');
    if (!own(sid)) { res.writeHead(404); return res.end(); }
    const H = hwOf(sid);
    return json(res, { on: repOn(me.id), due: repDue(H).map(x => ({ id: x.id, img: x.img, text: x.text, num: x.num, ans: x.ans, n: x.n || 1, at: x.at })), left: (H.mis || []).length, fixed: H.fixed || 0 });
  }
  if (req.method === 'POST' && u.pathname === '/api/admin/hw-rep') return body(req, res, 1e4, j => {
    if (j.on) delete REPOFF[me.id]; else REPOFF[me.id] = 1;
    fs.writeFileSync(REPF, JSON.stringify(REPOFF)); json(res, { on: repOn(me.id) });
  });
  if (req.method === 'GET' && u.pathname === '/api/admin/hw-draft') { // черновик домашки (собирается во время урока, отправляется позже)
    const sid = String(u.searchParams.get('s') || '');
    if (!own(sid)) { res.writeHead(404); return res.end(); }
    return json(res, hwOf(sid).draft || null);
  }
  if (req.method === 'GET' && u.pathname === '/api/admin/hw') {
    const sid = String(u.searchParams.get('s') || '');
    if (!own(sid)) { res.writeHead(404); return res.end(); }
    return json(res, hwOf(sid).list);
  }
  if (req.method === 'POST' && u.pathname === '/api/admin/hw') return body(req, res, 60e6, j => {
    const sid = String(j.s || ''); if (!own(sid)) { res.writeHead(404); return res.end(); }
    const H = hwOf(sid), h = H.list.find(x => x.id === j.id);
    if (j.t === 'draft' || j.t === 'draft-del') { // сохранить / удалить черновик; картинки уже сохранённых задач не пересылаются заново
      const old = H.draft || { tasks: [] }, keep = new Set();
      if (j.t === 'draft-del') { old.tasks.forEach(t => hwRm(sid, t.img)); H.draft = null; hwSave(sid); return json(res, null); }
      if (!Array.isArray(j.tasks) || j.tasks.length > 40) return json(res, { error: 'Не больше 40 задач' });
      const mine = new Set(old.tasks.map(t => t.img).filter(Boolean)), tasks = [];
      for (const t of j.tasks) {
        let img = null;
        if (t.imgName && mine.has(t.imgName)) img = t.imgName; else if (t.img) img = hwImg(sid, t.img, 880000);
        if (img) keep.add(img);
        tasks.push({ img, w: num(t.w, 1, 1e5, 1000), h: num(t.h, 1, 1e5, 600), text: String(t.text || '').slice(0, 2000), num: Math.round(num(t.num, 0, 19, 0)), ans: String(t.ans || '').trim().slice(0, 80), auto: !!t.auto, key: String(t.key || '').slice(0, 120) });
      }
      old.tasks.forEach(t => { if (t.img && !keep.has(t.img)) hwRm(sid, t.img); });
      H.draft = { title: String(j.title || '').slice(0, 80), due: String(j.due || '').slice(0, 10), tasks, at: Date.now() };
      hwSave(sid); return json(res, H.draft);
    }
    if (j.t === 'add') {
      if (!Array.isArray(j.tasks) || !j.tasks.length || j.tasks.length > 40) return json(res, { error: 'Добавьте от 1 до 40 задач' });
      if (H.list.length >= 300) return json(res, { error: 'Слишком много домашек у ученика: удалите старые' });
      const tasks = [];
      for (const t of j.tasks) {
        const dimg = t.imgName && H.draft && H.draft.tasks.some(x => x.img === t.imgName) ? t.imgName : null;
        const text = String(t.text || '').trim().slice(0, 2000), img = dimg || (t.img ? hwImg(sid, t.img, 880000) : null);
        if (!img && !text) continue;
        tasks.push({ id: crypto.randomBytes(4).toString('hex'), img, w: num(t.w, 1, 1e5, 1000), h: num(t.h, 1, 1e5, 600), text, num: Math.round(num(t.num, 0, 19, 0)), ans: String(t.ans || '').trim().slice(0, 80) });
      }
      if (!tasks.length) return json(res, { error: 'В задачах нет ни картинки, ни текста' });
      if (H.draft) { const used = new Set(tasks.map(t => t.img)); H.draft.tasks.forEach(t => { if (t.img && !used.has(t.img)) hwRm(sid, t.img); }); H.draft = null; } // черновик отправлен
      const due0 = Number.isFinite(+j.due) && +j.due > 0 ? +j.due : null, title0 = String(j.title || '').trim().slice(0, 80) || 'Домашка';
      if (isGroup(sid)) { // домашка группе: каждому участнику своя копия (свои ответы, проверка, прогресс, уведомления)
        const mem = membersOf(sid); if (!mem.length) { tasks.forEach(t => hwRm(sid, t.img)); hwSave(sid); return json(res, { error: 'В группе пока нет учеников — добавьте их кнопкой «Участники»' }); }
        const dd = due0 ? ', сдать до ' + dmy(due0) : '';
        for (const m of mem) {
          const M = hwOf(m); if (M.list.length >= 300) continue;
          const mt = tasks.map(t => Object.assign({}, t, { id: crypto.randomBytes(4).toString('hex'), img: t.img ? hwCopyTo(sid, t.img, m) : null }));
          const mh = { id: crypto.randomBytes(5).toString('hex'), title: title0, due: due0, created: Date.now(), tasks: mt, st: 'new', answers: {}, auto: {}, marks: {}, photos: [], board: null, comment: '', group: sid };
          M.list.unshift(mh); hwSave(m);
          const mn = nameOf(m);
          tgStudent(m, w => w === 's' ? '📚 Новая домашка от ' + me.name + ': «' + mh.title + '» (' + mt.length + ' зад.' + dd + ').\nОткрыть: ' + TG.site + '/s/' + m + '?hw=' + mh.id
            : '📚 ' + mn + ': задана домашка «' + mh.title + '»' + dd + '.');
        }
        tasks.forEach(t => hwRm(sid, t.img)); hwSave(sid);
        return json(res, { group: true, sent: mem.length });
      }
      const nid = crypto.randomBytes(5).toString('hex'), want = Array.isArray(j.rep) && repOn(me.id) ? j.rep.map(String) : [];
      for (const x of repDue(H)) if (want.includes(x.id)) { // задачи на повторение — в конец домашки
        tasks.push({ id: crypto.randomBytes(4).toString('hex'), img: x.img ? hwCopy(sid, x.img) : null, w: x.w, h: x.h, text: x.text, num: x.num, ans: x.ans, rep: x.id });
        x.out = nid;
      }
      const due = Number.isFinite(+j.due) && +j.due > 0 ? +j.due : null;
      const nh = { id: nid, title: String(j.title || '').trim().slice(0, 80) || 'Домашка', due, created: Date.now(), tasks, st: 'new', answers: {}, auto: {}, marks: {}, photos: [], board: null, comment: '' };
      H.list.unshift(nh);
      const sn = own(sid).name, dd = due ? ', сдать до ' + dmy(due) : '';
      tgStudent(sid, w => w === 's' ? '📚 Новая домашка от ' + me.name + ': «' + nh.title + '» (' + tasks.length + ' зад.' + dd + ').\nОткрыть: ' + TG.site + '/s/' + sid + '?hw=' + nh.id
        : '📚 ' + sn + ': задана домашка «' + nh.title + '»' + dd + '.');
    } else if (!h) return json(res, { error: 'Домашка не найдена' });
    else if (j.t === 'check') {
      h.marks = {}; for (const t of h.tasks) { const v = (j.marks || {})[t.id]; if (v === 0 || v === 1) h.marks[t.id] = v; }
      h.comment = String(j.comment || '').slice(0, 2000); h.st = 'checked'; h.checkedAt = Date.now();
      repCheck(sid, H, h);
      const ms = h.tasks.map(t => h.marks[t.id] !== undefined ? h.marks[t.id] : h.auto[t.id]).filter(v => v !== undefined), ok = ms.filter(Boolean).length;
      const sc = ms.length ? ': верно ' + ok + ' из ' + ms.length : '', sn = own(sid).name;
      tgStudent(sid, w => w === 's' ? '✔️ Домашка «' + h.title + '» проверена' + sc + '.' + (h.comment ? '\n💬 ' + h.comment : '') + '\n' + TG.site + '/s/' + sid + '?hw=' + h.id
        : '✔️ ' + sn + ': домашка «' + h.title + '» проверена' + sc + '.' + (h.comment ? '\n💬 ' + h.comment : ''));
    } else if (j.t === 'return') {
      h.st = 'new'; h.comment = String(j.comment || h.comment || '').slice(0, 2000);
      if (j.due !== undefined) { const d = +j.due; h.due = Number.isFinite(d) && d > 0 ? d : null; h.rem = 0; }
      const sn = own(sid).name, dd = h.due ? ' Сдать до ' + dmy(h.due) + '.' : '';
      tgStudent(sid, w => w === 's' ? '↩️ Домашку «' + h.title + '» вернули на доработку.' + dd + (h.comment ? '\n💬 ' + h.comment : '') + '\nИсправь и сдай снова: ' + TG.site + '/s/' + sid + '?hw=' + h.id
        : '↩️ ' + sn + ': домашку «' + h.title + '» вернули на доработку.' + dd + (h.comment ? '\n💬 ' + h.comment : ''));
    } else if (j.t === 'due') { // перенести срок сдачи
      const d = +j.due; h.due = Number.isFinite(d) && d > 0 ? d : null; h.rem = 0;
      if (h.st === 'new') tgStudent(sid, w => w === 's' ? '📅 Срок домашки «' + h.title + '» ' + (h.due ? 'перенесён: сдать до ' + dmy(h.due) + '.' : 'снят: сдай, когда будет готово.') + '\n' + TG.site + '/s/' + sid + '?hw=' + h.id : null);
    }
    else if (j.t === 'del') {
      h.tasks.forEach(t => hwRm(sid, t.img)); h.photos.forEach(p => hwRm(sid, p));
      (H.mis || []).forEach(x => { if (x.out === h.id) x.out = null; }); // задача на повторение вернётся в следующую домашку
      H.list = H.list.filter(x => x !== h);
    } else { res.writeHead(400); return res.end(); }
    hwSave(sid); json(res, H.list);
  });
  res.writeHead(404); res.end();
}
function hwStudent(req, res, sid) { // /api/<id>/hw — открывается по ссылке ученика
  const s = index.students.find(x => x.id === sid);
  if (!s || s.type === 'group') { res.writeHead(404); return res.end(); }
  const H = hwOf(sid);
  const out = () => {
    const r = room(sid), t = byId(s.owner);
    json(res, { name: s.name, teacher: t ? t.name : '', groups: groupsOf(sid).map(g => ({ id: g.id, name: g.name })), rep: { fixed: H.fixed || 0, left: (H.mis || []).length }, list: H.list.map(hwPublic), pages: r ? r.s.pages.map(p => ({ id: p.id, title: p.title })) : [], tg: TG.token ? { s: tgLink('s' + sid), p: tgLink('p' + sid), on: (TG.subs[sid] || []).some(x => x.who === 's') } : null });
  };
  if (req.method === 'GET') return out();
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  body(req, res, 3e6, j => {
    const h = H.list.find(x => x.id === j.id);
    if (!h) return json(res, { error: 'Домашка не найдена' });
    if (j.t === 'board') { h.board = hwBoard(sid, h); hwSave(sid); return out(); }
    if (h.st !== 'new') return json(res, { error: 'Домашка уже сдана' });
    if (j.t === 'answers') {
      h.answers = {}; for (const t of h.tasks) { const a = String((j.answers || {})[t.id] || '').slice(0, 80); if (a) h.answers[t.id] = a; }
    } else if (j.t === 'photo') {
      if (h.photos.length >= 12) return json(res, { error: 'Не больше 12 фото к одной домашке' });
      const n = hwImg(sid, j.src, 2.5e6); if (!n) return json(res, { error: 'Фото не подошло' });
      h.photos.push(n);
    } else if (j.t === 'photo-del') {
      if (h.photos.includes(j.name)) { hwRm(sid, j.name); h.photos = h.photos.filter(p => p !== j.name); }
    } else if (j.t === 'submit') {
      // без решения сдать нельзя: нужно фото тетради или своё решение на доске домашки
      let work = h.photos.length > 0;
      const rr = h.board && room(sid);
      if (!work && rr) work = Object.keys(rr.s.strokes[h.board] || {}).some(id => !/^h[0-9a-f]+t$/.test(id)) || Object.keys(rr.s.images[h.board] || {}).some(id => !/^h[0-9a-f]+i$/.test(id));
      if (!work) return json(res, { error: h.board ? 'На доске с домашкой пока нет решения. Решите задачи на доске или прикрепите фото тетради.' : 'Прикрепите фото решения из тетради или решите задачи на доске — без решения домашку сдать нельзя.' });
      h.auto = {}; for (const t of h.tasks) if (t.ans) h.auto[t.id] = right(t.ans, h.answers[t.id]) ? 1 : 0;
      h.st = 'sent'; h.sentAt = Date.now();
      const okA = Object.values(h.auto).filter(Boolean).length, nA = Object.keys(h.auto).length;
      tgTeacher(s.owner, '📥 ' + s.name + ' сдал(а) домашку «' + h.title + '»' + (nA ? ' (автопроверка: ' + okA + ' из ' + nA + ')' : '') + '.\nПроверить: ' + TG.site + '/t');
      tgStudent(sid, w => w === 'p' ? '📥 ' + s.name + ' сдал(а) домашку «' + h.title + '».' : null);
    } else { res.writeHead(400); return res.end(); }
    hwSave(sid); out();
  });
}

function dropRoom(id) { // удалить доску ученика целиком
  const r = rooms[id]; if (r) { r.clients.forEach(c => c.end()); delete rooms[id]; }
  if (RID.test(String(id))) {
    fs.unlink(path.join(DIR, id + '.json'), () => {});
    delete hwc[id]; fs.unlink(path.join(HWD, id + '.json'), () => {});
    if (SN[id]) { delete SN[id]; saveSN(); } fs.rm(path.join(SND, id), { recursive: true, force: true }, () => {}); fs.rm(path.join(HWD, id), { recursive: true, force: true }, () => {});
  }
}
function admin(req, res, u) {
  const me = auth(req);
  if (!me) { res.writeHead(ADMIN || teachersOnly().length ? 401 : 503); return res.end(); }
  const mine = () => index.students.filter(s => s.owner === me.id);
  const isOwner = me.id === 'owner';
  if (req.method === 'GET' && u.pathname === '/api/admin/me') return json(res, who(me));
  if (req.method === 'GET' && u.pathname === '/api/admin/students') return json(res, mine());
  if (u.pathname === '/api/admin/hw' || u.pathname === '/api/admin/hw-pending' || u.pathname === '/api/admin/hw-rep' || u.pathname === '/api/admin/hw-draft') return hwTeacher(req, res, u, me);
  if (u.pathname === '/api/admin/tg' || u.pathname === '/api/admin/tg-student') return tgAdmin(req, res, u, me);
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
    } else if (j.t === 'group-add' && nm) {
      if (mine().length >= 300) return json(res, { error: 'Слишком много учеников и групп' });
      const id = crypto.randomBytes(6).toString('hex'), mem = (Array.isArray(j.members) ? j.members : []).map(String).filter(m => own(m) && !isGroup(m));
      index.students.push({ id, name: nm, color: '#6a3fc4', owner: me.id, type: 'group', members: [...new Set(mem)] });
      saveIndex(); save(room(id));
    } else if (j.t === 'group-set') {
      const g = own(j.id); if (!g || g.type !== 'group') return json(res, { error: 'Группа не найдена' });
      if (nm) g.name = nm;
      if (Array.isArray(j.members)) g.members = [...new Set(j.members.map(String).filter(m => own(m) && !isGroup(m)))];
      saveIndex();
    } else if (j.t === 'rename' && nm) {
      const s = own(j.id); if (s) { s.name = nm; saveIndex(); }
    } else if (j.t === 'delete') {
      if (own(j.id)) { index.students = index.students.filter(x => x.id !== j.id); index.students.forEach(g => { if (g.members) g.members = g.members.filter(m => m !== j.id); }); saveIndex(); dropRoom(j.id); }
    } else if (j.t === 'restore' && j.data && j.data.index && Array.isArray(j.data.index.students)) {
      const taken = new Set(index.students.filter(s => s.owner !== me.id).map(s => s.id)); // чужих учеников копия не трогает
      const inc = j.data.index.students.filter(s => RID.test(String(s.id)) && !taken.has(s.id))
        .map(s => Object.assign({ id: s.id, name: String(s.name || '').slice(0, 60), color: String(s.color || '#888').slice(0, 9), owner: me.id }, s.type === 'group' ? { type: 'group', members: (Array.isArray(s.members) ? s.members : []).map(String).filter(m => RID.test(m)) } : {}));
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
    return sendFile(req, res, path.join(__dirname, pj[1]), 'text/javascript; charset=utf-8', 'public, max-age=86400');
  }
  if (u.pathname === '/api/ice') { // ключи TURN выдаём только тем, кто открыл существующую доску
    const rr = String(u.searchParams.get('r') || '');
    if (!RID.test(rr) || !room(rr)) { res.writeHead(404); return res.end(); }
    return iceServers().then(v => json(res, v));
  }
  if (req.method === 'POST' && u.pathname === '/api/log') { // ошибки скрипта у пользователей — в журнал сервера (journalctl -u board)
    const mn = Math.floor(Date.now() / 60000); if (logMin !== mn) { logMin = mn; logN = 0; }
    if (++logN > 60) { res.writeHead(204); return res.end(); }
    return body(req, res, 4000, j => { console.log('client-error', JSON.stringify(j).slice(0, 1500)); res.writeHead(204); res.end(); });
  }
  const snp = u.pathname.match(/^\/api\/([a-z0-9]{4,32})\/snap$/);
  if (snp && req.method === 'POST') return snapPost(req, res, snp[1]);
  const hm = u.pathname.match(/^\/api\/([a-z0-9]{4,32})\/hw$/);
  if (hm) return hwStudent(req, res, hm[1]);
  const hi = u.pathname.match(/^\/hwimg\/([a-z0-9]{4,32})\/([a-f0-9]{16}\.(jpg|png|webp))$/);
  if (hi) { // картинки задач и фото тетрадей
    const f = path.join(HWD, hi[1], hi[2]);
    if (!index.students.some(x => x.id === hi[1]) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/' + (hi[3] === 'jpg' ? 'jpeg' : hi[3]), 'Cache-Control': 'private, max-age=604800' });
    return fs.createReadStream(f).pipe(res);
  }
  const sp = u.pathname.match(/^\/s\/([a-z0-9]{4,32})$/);
  if (sp) { // кабинет ученика
    if (!index.students.some(x => x.id === sp[1] && x.type !== 'group')) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;max-width:420px;margin:12vh auto;padding:0 18px"><h2>Кабинет не найден</h2><p>Попросите у преподавателя новую ссылку.</p>'); }
    return PAGE('student.html')(req, res);
  }
  const m = u.pathname.match(/^\/api\/([a-z0-9]{4,32})\/(events|op)$/);
  if (m) {
    const r = room(m[1]);
    if (!r) { res.writeHead(404); return res.end(); }
    if (m[2] === 'events' && req.method === 'GET') {
      // поток событий сжимаем: доска с картинками при открытии приходит в 3–5 раз быстрее, каждое сообщение уходит сразу (flush)
      const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }, gz ? { 'Content-Encoding': 'gzip' } : {}));
      let cl = res;
      if (gz) {
        const z = zlib.createGzip({ level: 6, memLevel: 7 }); z.pipe(res); z.on('error', () => {});
        cl = { write: d => { z.write(d); z.flush(); }, end: () => z.end() };
      }
      const cid = String(u.searchParams.get('c') || ''), uid = String(u.searchParams.get('u') || '');
      const who = isGroup(r.id) && membersOf(r.id).includes(uid) ? nameOf(uid) : null; cl.who = who;
      const peers = () => ({ t: 'peers', n: r.clients.size, who: [...r.clients].map(c => c.who).filter(Boolean) });
      cl.write('data: ' + JSON.stringify({ t: 'init', s: r.s, name: who || nameOf(r.id), group: isGroup(r.id) ? nameOf(r.id) : undefined, call: [...r.call] }) + '\n\n');
      r.clients.add(cl);
      bcast(r, peers());
      const ping = setInterval(() => cl.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping); r.clients.delete(cl); if (gz) cl.end(); bcast(r, peers());
        if (RID.test(cid) && r.call.delete(cid)) bcast(r, { t: 'rtc', kind: 'bye', from: cid });
      });
      return;
    }
    if (m[2] === 'op' && req.method === 'POST') return body(req, res, 1.2e6, op => {
      if (!apply(r.s, op)) { res.writeHead(400); return res.end(); }
      if (op.t === 'rtc') { if (op.kind === 'hello') r.call.add(op.from); if (op.kind === 'bye') r.call.delete(op.from); }
      bcast(r, op);
      if (!['live', 'rtc', 'cursor', 'laser', 'view'].includes(op.t)) save(r);
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
  if (u.pathname === '/' || u.pathname === '/index.html') return PAGE('index.html')(req, res); // главная страница
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
