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

let tpl = fs.readFileSync(TEMPLATE, 'utf8');
// 内联共享样式 cockpit-style.css（单一风格来源），保证静态部署不依赖外链文件
const CSS_PATH = path.join(ROOT, 'cockpit-style.css');
let cockpitCss = '';
try { cockpitCss = fs.readFileSync(CSS_PATH, 'utf8'); } catch (e) { /* 无则跳过 */ }
if (cockpitCss) {
  const linkTag = '<link rel="stylesheet" href="cockpit-style.css">';
  if (tpl.indexOf(linkTag) >= 0) {
    tpl = tpl.replace(linkTag, '<style>\n' + cockpitCss + '\n</style>');
  }
}
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

// ---------- 二级页面（车辆管理 / 任务管理）一并打包 ----------
// 注入内嵌数据 + 内联共享样式，保证在线部署（无桥接服务）也能显示真实数据、风格一致
const SECONDARY = ['车辆管理.html', '任务管理.html', '签证管理.html'];
const dataScript = '\nwindow.__COCKPIT_DATA__ = ' + json + ';\n';
const distDir = path.dirname(DIST);
const outDir = path.dirname(OUT);
SECONDARY.forEach(name => {
  const sp = path.join(ROOT, name);
  if (!fs.existsSync(sp)) { console.error('跳过（不存在）: ' + name); return; }
  let s = fs.readFileSync(sp, 'utf8');
  const si = s.indexOf('<script>');
  if (si >= 0) {
    s = s.slice(0, si) + '<script>' + dataScript + s.slice(si + '<script>'.length);
  }
  const linkTag = '<link rel="stylesheet" href="cockpit-style.css">';
  if (s.indexOf(linkTag) >= 0) {
    s = s.replace(linkTag, '<style>\n' + cockpitCss + '\n</style>');
  }
  fs.writeFileSync(path.join(distDir, name), s, 'utf8');
  fs.writeFileSync(path.join(outDir, name), s, 'utf8');
  console.log('SECONDARY ' + name);
});
// 复制共享样式到部署目录（外链兜底）
try { fs.copyFileSync(CSS_PATH, path.join(distDir, 'cockpit-style.css')); } catch (e) {}
try { fs.copyFileSync(CSS_PATH, path.join(outDir, 'cockpit-style.css')); } catch (e) {}

console.log('BUILT ' + OUT);
console.log('INDEX ' + INDEX);
console.log('DIST  ' + DIST);
console.log('  tasks=' + tasks.length + ' rooms=' + rooms.length + ' visas=' + visas.length + ' vehicles=' + vehicles.length + ' vehiclesched=' + vehiclesched.length);
console.log('  updatedAt=' + updatedAt);
