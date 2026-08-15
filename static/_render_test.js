// 无头渲染测试：用最小 DOM 桩跑静态版脚本，确认打开即渲染、无异常
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('static/行政部驾驶舱_静态版.html', 'utf8');
const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
let code = '';
for (const b of blocks) { const c = b.replace(/<\/?script>/g, ''); if (c.length > code.length) code = c; }

function makeEl() {
  return {
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {}, children: [],
    textContent: '', innerHTML: '', value: '', onclick: null, className: '',
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, insertBefore(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    cloneNode() { return makeEl(); }, getContext() { return null; },
    focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; }
  };
}
const elements = {};
const document = {
  getElementById(id) { if (!elements[id]) elements[id] = makeEl(); return elements[id]; },
  querySelector() { return makeEl(); },
  querySelectorAll() { return []; },
  createElement() { return makeEl(); },
  body: makeEl(), documentElement: makeEl(), addEventListener() {}
};
const store = {};
const localStorage = {
  getItem(k) { return k in store ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; }
};
const sandbox = {
  document, localStorage, console,
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
  fetch: () => Promise.reject(new Error('no-fetch-in-test')),
  requestAnimationFrame: () => 0,
  Math, Date, JSON, parseInt, parseFloat, isNaN, Array, Object, String, Number, RegExp, Error, Promise
};
sandbox.window = sandbox;

let ok = true;
try { vm.runInNewContext(code, sandbox, { filename: 'static.js' }); }
catch (e) { ok = false; console.log('RENDER_THROW:', e.message); }

if (ok) {
  const syncText = (elements['syncText'] && elements['syncText'].textContent) || '';
  const roomCards = (elements['roomCards'] && elements['roomCards'].innerHTML) || '';
  const visaBoard = (elements['visaBoard'] && elements['visaBoard'].innerHTML) || '';
  const visaKpi = (elements['visaKpi'] && elements['visaKpi'].innerHTML) || '';
  const kpis = (elements['kpis'] && elements['kpis'].innerHTML) || '';
  const embedded = !!sandbox.__COCKPIT_DATA__;

  console.log('embedded_data=' + embedded);
  console.log('syncText="' + syncText + '"');
  console.log('roomCards_len=' + roomCards.length + ' (会议室应渲染)');
  console.log('visaBoard_len=' + visaBoard.length + ' (签证空态应有引导)');
  console.log('visaKpi_len=' + visaKpi.length);
  console.log('kpis_len=' + kpis.length + ' (部门KPI应渲染)');
  const pass =
    embedded &&
    syncText === '数据已内嵌' &&
    roomCards.length > 200 &&
    /empty|请在|签证/.test(visaBoard) &&
    visaKpi.length > 0 &&
    kpis.length > 200;
  console.log(pass ? 'RENDER_OK' : 'RENDER_FAIL');
}
