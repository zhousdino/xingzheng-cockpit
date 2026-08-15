// build.js —— 生成「免服务器」静态驾驶舱
// 读取 bridge/drop 下的三个 CSV（任务/会议室/签证），复用 bridge/parse.js 解析，
// 把数据内嵌进 行政部驾驶舱_UI_v1.10.0.html 模板，输出 行政部驾驶舱_静态版.html。
// 静态版自带数据，无需桥接服务 / 无需后端，可直接部署到任意静态托管（CloudStudio / 资料库 / 本地双击）。
//
// 用法：node static/build.js
// 前置：bridge/drop/{wps,tencent,visa} 下需有对应 CSV（由同步自动化经连接器写入）。

const fs = require('fs');
const path = require('path');
const { parseTasks, parseRooms, parseVisas, parseVehicles, parseVehicleSched } = require('../bridge/parse.js');

const ROOT = path.resolve(__dirname, '..');
const DROP = path.join(ROOT, 'bridge', 'drop');
const TEMPLATE = path.join(ROOT, '行政部驾驶舱_UI_v1.10.0.html');
const OUT = path.join(ROOT, 'static', '行政部驾驶舱_静态版.html');

// 读取某 drop 目录下最新的一份 CSV/TSV 并解析
function readDrop(name, parseFn) {
  const dir = path.join(DROP, name);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => /\.(csv|tsv|txt)$/i.test(f));
  if (!files.length) return [];
  files.sort((a, b) =>
    fs.statSync(path.join(dir, a)).mtimeMs - fs.statSync(path.join(dir, b)).mtimeMs);
  const latest = files[files.length - 1];
  const txt = fs.readFileSync(path.join(dir, latest), 'utf8');
  try { return parseFn(txt); } catch (e) { console.error('parse', name, 'failed:', e.message); return []; }
}

const tasks = readDrop('wps', parseTasks);
const rooms = readDrop('tencent', parseRooms);
const visas = readDrop('visa', parseVisas);
const vehicles = readDrop('vehicle', parseVehicles);
const vehiclesched = readDrop('vehiclesched', parseVehicleSched);

const updatedAt = new Date().toISOString();
const sources = {
  tasks:   { mode: tasks.length ? 'drop-file' : 'wps-none',    updatedAt, error: null },
  rooms:   { mode: rooms.length ? 'drop-file' : 'tencent-none',updatedAt, error: null },
  visas:   { mode: visas.length ? 'drop-file' : 'visa-none',   updatedAt, error: null },
  vehicles:{ mode: vehicles.length ? 'drop-file' : 'vehicle-none', updatedAt, error: null },
  vehiclesched: { mode: vehiclesched.length ? 'drop-file' : 'vehiclesched-none', updatedAt, error: null }
};
const data = { tasks, rooms, visas, vehicles, vehiclesched, updatedAt, sources };

const tpl = fs.readFileSync(TEMPLATE, 'utf8');
// 把内嵌数据注入到 `let DATA=[];` 之前（该全局在 loadData 调用前已就绪）
const json = JSON.stringify(data).replace(/<\//g, '<\\/');
const marker = '\nlet DATA=[];';
if (tpl.indexOf(marker) < 0) { console.error('INJECT_FAILED: 未找到注入点'); process.exit(1); }
const injected = tpl.replace(marker, '\nwindow.__COCKPIT_DATA__ = ' + json + ';\nlet DATA=[];');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, injected, 'utf8');

// 同时输出 index.html 作为静态托管入口（CloudStudio / 任意静态服务器默认首页）
const INDEX = path.join(path.dirname(OUT), 'index.html');
fs.writeFileSync(INDEX, injected, 'utf8');

// 同步到部署目录 dist/（供 CloudStudio 重新部署时读取最新数据）
const DIST = path.join(ROOT, 'dist', 'index.html');
fs.mkdirSync(path.dirname(DIST), { recursive: true });
fs.writeFileSync(DIST, injected, 'utf8');

console.log('BUILT ' + OUT);
console.log('INDEX ' + INDEX);
console.log('DIST  ' + DIST);
console.log('  tasks=' + tasks.length + ' rooms=' + rooms.length + ' visas=' + visas.length + ' vehicles=' + vehicles.length + ' vehiclesched=' + vehiclesched.length);
console.log('  updatedAt=' + updatedAt);
