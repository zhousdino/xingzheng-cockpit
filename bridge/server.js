// server.js —— 行政部驾驶舱本地桥接服务（纯 Node，零依赖）
// 职责：① 托管驾驶舱网页；② 提供 /api/data 最新数据；③ /api/sync 触发抓取；
//      ④ /api/upload 浏览器同源推送（最稳，无跨域）；⑤ 监听 drop/ 文件夹丢入的 CSV。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { fetchWPS, fetchTencent } = require('./fetchers');
const { parseTasks, parseRooms, parseVisas, parseVehicles, parseVehicleSched } = require('./parse');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DROP_DIR = path.join(ROOT, 'drop');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const UI_FILE = path.join(ROOT, '..', '行政部驾驶舱_UI_v1.10.0.html');
const PORT = process.env.PORT || 8787;

/* ---------- 配置（敏感：勿提交到 git） ---------- */
let CONFIG = { wps: {}, tencent: {} };
try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (e) { /* 用默认 */ }

/* ---------- 数据状态 ---------- */
let STATE = {
  updatedAt: null,
  tasks: [],
  rooms: [],
  visas: [],
  vehicles: [],
  vehiclesched: [],
  sources: {
    tasks: { mode: 'init', updatedAt: null, error: null },
    rooms: { mode: 'init', updatedAt: null, error: null },
    visas: { mode: 'init', updatedAt: null, error: null },
    vehicles: { mode: 'init', updatedAt: null, error: null },
    vehiclesched: { mode: 'init', updatedAt: null, error: null }
  }
};
function loadState() {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    // 合并保留当前 STATE 完整结构（含新增字段如 vehicles/vehiclesched），用旧值覆盖已有键，避免回退丢字段
    const sources = Object.assign({}, STATE.sources, loaded.sources || {});
    STATE = Object.assign({}, STATE, loaded);
    STATE.sources = sources;
  } catch (e) { /* 空状态，保留默认 STATE */ }
}
function saveState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(STATE, null, 2), 'utf-8');
}

/* ---------- drop/ 文件夹读取（最稳兜底） ---------- */
function newestDropFile(subdir) {
  const dir = path.join(DROP_DIR, subdir);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => /\.(csv|tsv|txt)$/i.test(f));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}
function readDrop(subdir, parser) {
  const f = newestDropFile(subdir);
  if (!f) return null;
  try {
    const txt = fs.readFileSync(f, 'utf-8');
    const rows = parser(txt);
    return rows && rows.length ? rows : null;
  } catch (e) { return null; }
}

/* ---------- 同步主流程 ---------- */
async function doSync() {
  const now = new Date().toISOString();

  // 1) 任务：先试 WPS 抓取，失败回退到 drop/
  let tasks = null, tasksMode = 'init';
  try {
    const r = await fetchWPS(CONFIG.wps || {});
    if (r.ok) { tasks = r.rows; tasksMode = r.mode; STATE.sources.tasks = { mode: r.mode, updatedAt: now, error: null }; }
    else { STATE.sources.tasks = { mode: r.mode, updatedAt: STATE.sources.tasks.updatedAt, error: r.error }; }
  } catch (e) { STATE.sources.tasks.error = e.message; }
  if (!tasks) {
    const d = readDrop('wps', parseTasks);
    if (d) { tasks = d; tasksMode = 'drop-file'; STATE.sources.tasks = { mode: 'drop-file', updatedAt: now, error: STATE.sources.tasks.error }; }
  }
  if (tasks) { STATE.tasks = tasks; }

  // 2) 会议室：先试腾讯抓取，失败回退到 drop/
  let rooms = null;
  try {
    const r = await fetchTencent(CONFIG.tencent || {});
    if (r.ok) { rooms = r.rows; STATE.sources.rooms = { mode: r.mode, updatedAt: now, error: null }; }
    else { STATE.sources.rooms = { mode: r.mode, updatedAt: STATE.sources.rooms.updatedAt, error: r.error }; }
  } catch (e) { STATE.sources.rooms.error = e.message; }
  if (!rooms) {
    const d = readDrop('tencent', parseRooms);
    if (d) { rooms = d; STATE.sources.rooms = { mode: 'drop-file', updatedAt: now, error: STATE.sources.rooms.error }; }
  }
  if (rooms) { STATE.rooms = rooms; }

  // 3) 签证：读取 drop/visa（由 WPS「签证」sheet 自动化写入）
  const visas = readDrop('visa', parseVisas);
  STATE.visas = visas || [];
  if (!STATE.sources.visas) STATE.sources.visas = { mode: 'init', updatedAt: null, error: null };
  if (visas) { STATE.sources.visas = { mode: 'drop-file', updatedAt: now, error: null }; }

  // 4) 车辆：读取 drop/vehicle 与 drop/vehiclesched（由「车辆信息」「车辆排期」sheet 自动化写入）
  const vehicles = readDrop('vehicle', parseVehicles);
  STATE.vehicles = vehicles || [];
  if (!STATE.sources.vehicles) STATE.sources.vehicles = { mode: 'init', updatedAt: null, error: null };
  if (vehicles) { STATE.sources.vehicles = { mode: 'drop-file', updatedAt: now, error: null }; }
  const vehiclesched = readDrop('vehiclesched', parseVehicleSched);
  STATE.vehiclesched = vehiclesched || [];
  if (!STATE.sources.vehiclesched) STATE.sources.vehiclesched = { mode: 'init', updatedAt: null, error: null };
  if (vehiclesched) { STATE.sources.vehiclesched = { mode: 'drop-file', updatedAt: now, error: null }; }

  STATE.updatedAt = now;
  saveState();
  return STATE;
}

/* ---------- HTTP 工具 ---------- */
function sendJSON(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/' || p === '/cockpit.html') {
      if (fs.existsSync(UI_FILE)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(UI_FILE, 'utf-8'));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>驾驶舱页面未找到</h2><p>请把 <b>行政部驾驶舱_UI_v1.6.2.html</b> 放在 bridge 的上一级目录，或访问 <a href="/api/data">/api/data</a> 查看接口。</p>');
      }
      return;
    }

    if (p === '/api/data') {
      loadState();
      sendJSON(res, 200, STATE);
      return;
    }

    if (p === '/api/status') {
      sendJSON(res, 200, {
        updatedAt: STATE.updatedAt,
        tasks: STATE.sources.tasks,
        rooms: STATE.sources.rooms,
        port: PORT
      });
      return;
    }

    if (p === '/api/sync' && req.method === 'POST') {
      let override = {};
      try { override = JSON.parse(await readBody(req)); } catch (e) { /* 无 body 也行 */ }
      if (override.wpsLink) CONFIG.wps.publicLink = override.wpsLink;
      if (override.tencentLink) CONFIG.tencent.publicLink = override.tencentLink;
      const st = await doSync();
      sendJSON(res, 200, { ok: true, updatedAt: st.updatedAt, tasks: st.tasks.length, rooms: st.rooms.length, visas: st.visas.length, vehicles: st.vehicles.length, vehiclesched: st.vehiclesched.length, sources: st.sources });
      return;
    }

    if (p === '/api/upload' && req.method === 'POST') {
      const body = await readBody(req);
      let payload; try { payload = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
      const type = payload.type === 'vehiclesched' ? 'vehiclesched' : (payload.type === 'vehicles' ? 'vehicles' : (payload.type === 'visas' ? 'visas' : (payload.type === 'rooms' ? 'rooms' : 'tasks')));
      const text = payload.text || '';
      if (!text.trim()) return sendJSON(res, 400, { ok: false, error: 'text 为空' });
      const rows = type === 'rooms' ? parseRooms(text)
        : (type === 'visas' ? parseVisas(text)
          : (type === 'vehicles' ? parseVehicles(text)
            : (type === 'vehiclesched' ? parseVehicleSched(text) : parseTasks(text))));
      if (!rows.length) return sendJSON(res, 400, { ok: false, error: '未解析到数据，请确认含表头' });
      STATE[type] = rows;
      STATE.sources[type] = { mode: 'browser-upload', updatedAt: new Date().toISOString(), error: null };
      STATE.updatedAt = new Date().toISOString();
      saveState();
      // 同时写入 drop，便于重启后仍在
      const dir = path.join(DROP_DIR, type === 'rooms' ? 'tencent' : (type === 'visas' ? 'visa' : (type === 'vehicles' ? 'vehicle' : (type === 'vehiclesched' ? 'vehiclesched' : 'wps'))));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'uploaded_' + Date.now() + '.csv'), text, 'utf-8');
      return sendJSON(res, 200, { ok: true, type, count: rows.length });
    }

    sendJSON(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: e.message });
  }
});

/* ---------- 启动 ---------- */
loadState();
server.listen(PORT, () => {
  console.log('行政部驾驶舱桥接服务已启动：http://localhost:' + PORT);
  console.log('数据文件：' + DATA_FILE);
  console.log('丢文件目录：' + path.join(DROP_DIR, 'wps') + '  与  ' + path.join(DROP_DIR, 'tencent'));
  // 定时自动同步（含读取 drop/）
  setInterval(() => { doSync().catch(e => console.error('自动同步出错:', e.message)); }, 60000);
  // 启动即同步一次
  doSync().then(() => console.log('首次同步完成。')).catch(e => console.error('首次同步失败:', e.message));
});

module.exports = { server, doSync, STATE };
