// parse.js —— 表格文本解析（与驾驶舱前端逻辑保持一致）
// 支持 TSV（从表格复制）与 CSV（逗号，含引号转义）
// 修订 v1.6.1：适配腾讯《会议室预约登记表》真实列（标题行 + 预约日期/时间段/预约人/会议主题，无"会议室"列、无"状态"列）

function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inq = false; }
      else if (c === '\n' || c === '\r') field += ' ';   // 引号内换行（双语表头）→ 空格，避免拆行
      else field += c;
    } else {
      if (c === '"') inq = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field !== '' || row.length) row.push(field);
  if (row.length) rows.push(row);
  return rows.map(r => r.map(c => String(c).replace(/\t/g, ' ')).join('\t')).join('\n');
}

function toTSV(text) {
  return text.indexOf('\t') >= 0 ? text : parseCSV(text);
}

// 全角→半角归一化辅助
function normDate(s) {
  s = String(s).trim();
  if (!s) return '';
  s = s.replace(/[．／]/g, m => ({ '．': '.', '／': '/' }[m]));
  s = s.replace(/[.\/]/g, '-');
  const p = s.split('-').filter(x => x !== '').map(x => x.replace(/\D/g, ''));
  if (p.length >= 3 && p[0]) return p[0] + '-' + String(p[1]).padStart(2, '0') + '-' + String(p[2]).padStart(2, '0');
  return s;
}
function normTime(s) {
  return String(s).trim()
    .replace(/[：]/g, ':')          // 全角冒号 → 半角
    .replace(/[－–—~]/g, '-');      // 全角/各种 dash → 半角减号
}

// 从多行中找"表头行"：第一个含 >=2 个已识别列的行；其上的标题行自动跳过
function findHeaderLine(lines, mapFn) {
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    let cnt = 0;
    for (const c of cells) if (mapFn(c)) cnt++;
    if (cnt >= 2) return i;
  }
  return 0;
}

const DEFAULT_ROOM = '会议室'; // 真实表无"会议室"列时的默认分组名

/* ---------- 任务（来源：WPS 在线表格） ---------- */
function mapHeader(h) {
  h = String(h).trim();
  const rules = [
    [/任务名称|任务名|事项/, 'name'],
    [/大类|类别|分类/, 'category'],
    [/堵点|卡点|阻碍/, 'blocker'],
    [/备注|子项/, 'note'],
    [/负责人/, 'owner'],
    [/协同/, 'collab'],
    [/状态/, 'status'],
    [/进度/, 'progress'],
    [/开始/, 'start'],
    [/截止|到期/, 'deadline'],
    [/优先级|紧急/, 'priority'],
    [/更新/, 'update'],
    [/逾期/, 'overdue']
  ];
  for (const [re, key] of rules) { if (re.test(h)) return key; }
  return null;
}
function parseTasks(text) {
  const lines = toTSV(text).replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const hi = findHeaderLine(lines, mapHeader);
  const head = lines[hi].split('\t').map((h, i) => ({ key: mapHeader(h), i }));
  const used = head.filter(h => h.key);
  if (!used.length) return [];
  const rows = [];
  for (let r = hi + 1; r < lines.length; r++) {
    const cells = lines[r].split('\t');
    const rec = { name: '', category: '', note: '', owner: '', collab: '', status: '未开始', progress: 0, start: '', deadline: '', priority: '', blocker: '', update: '' };
    for (const h of used) {
      let v = (cells[h.i] || '').trim();
      if (h.key === 'progress') v = parseInt(v) || 0;
      if (h.key === 'deadline' || h.key === 'start') v = normDate(v);
      rec[h.key] = v;
    }
    if (!rec.name) continue;
    rows.push(rec);
  }
  return rows;
}

/* ---------- 会议室（来源：腾讯在线表格） ---------- */
function mapRoomHeader(h) {
  h = String(h).trim();
  const rules = [
    [/起止|时间段|时间范围/, 'span'],
    [/会议室|房间|会议室名称|地点/, 'room'],
    [/日期|预约日期/, 'date'],
    [/开始时间|开始/, 'start'],
    [/结束时间|结束|止/, 'end'],
    [/预约人|预订人|申请人|预定人/, 'booker'],
    [/联系电话|电话|手机/, 'phone'],
    [/参会人数|人数/, 'attendees'],
    [/用途|会议主题|事项|内容|主题/, 'purpose'],
    [/状态/, 'status']
  ];
  for (const [re, key] of rules) { if (re.test(h)) return key; }
  return null;
}
function parseRooms(text) {
  const lines = toTSV(text).replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const hi = findHeaderLine(lines, mapRoomHeader);
  const head = lines[hi].split('\t').map((h, i) => ({ key: mapRoomHeader(h), i }));
  const used = head.filter(h => h.key);
  if (!used.length) return [];
  const hasRoom = used.some(h => h.key === 'room');
  const rows = [];
  for (let r = hi + 1; r < lines.length; r++) {
    const cells = lines[r].split('\t');
    const rec = { room: '', date: '', start: '', end: '', booker: '', purpose: '', status: '', attendees: '', phone: '' };
    for (const h of used) {
      let v = (cells[h.i] || '').trim();
      if (h.key === 'date') v = normDate(v);
      else if (h.key === 'span') {
        const t = normTime(v);
        const mm = t.match(/(\d{1,2}:\d{2})\s*[-–—~]\s*(\d{1,2}:\d{2})/);
        if (mm) { rec.start = mm[1]; rec.end = mm[2]; }
      } else if (h.key === 'start' || h.key === 'end') v = normTime(v);
      else if (h.key === 'attendees') v = v.replace(/\D/g, '');
      rec[h.key] = v;
    }
    if (!hasRoom) rec.room = DEFAULT_ROOM;
    // 跳过整行空的预约
    if (!rec.start && !rec.booker && !rec.purpose) continue;
    rows.push(rec);
  }
  return rows;
}

/* ---------- 签证（来源：资料库云表「签证情况」） ---------- */
function mapVisaHeader(h) {
  h = String(h).trim();
  const rules = [
    [/姓名|名字|人员|申请人|持证人|办理人/, 'name'],
    [/护照类型|护照种类/, 'pptType'],
    [/护照.*有效期|护照到期|护照.*至/, 'pptExp'],
    [/签证类型|签种|类型|visa类型/, 'vtype'],
    [/签证签发|签发日期|出签日期/, 'issue'],
    [/签证到期|签证.*至/, 'expiry'],
    [/Iqama|依卡玛|居留/, 'iqama'],
    [/飞签/, 'flysign']
  ];
  for (const [re, key] of rules) { if (re.test(h)) return key; }
  return null;
}
function parseVisas(text) {
  const lines = toTSV(text).replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const hi = findHeaderLine(lines, mapVisaHeader);
  const head = lines[hi].split('\t').map((h, i) => ({ key: mapVisaHeader(h), i }));
  const used = head.filter(h => h.key);
  if (!used.length) return [];
  const rows = [];
  for (let r = hi + 1; r < lines.length; r++) {
    const cells = lines[r].split('\t');
    const rec = { name: '', pptType: '', pptExp: '', vtype: '', issue: '', expiry: '', iqama: '未开始', flysign: '' };
    for (const h of used) {
      let v = (cells[h.i] || '').trim();
      if (h.key === 'pptExp' || h.key === 'issue' || h.key === 'expiry' || h.key === 'flysign') v = normDate(v);
      rec[h.key] = v;
    }
    if (!rec.name && !rec.vtype) continue;
    rows.push(rec);
  }
  return rows;
}

/* ============ 车辆信息（来源：资料库云数据表「行政部-车辆信息」） ============ */
function mapVehicleHeader(h) {
  h = String(h).trim();
  const rules = [
    [/车牌|车号|号牌/, 'plate'],
    [/车型|车辆型号|品牌|厂牌/, 'model'],
    [/车辆类别|类别|车类/, 'vehClass'],
    [/燃料类型|燃料|能源类型/, 'fuel'],
    [/车架号|车架|VIN|vin/i, 'vin'],
    [/所有.*情况|性质|归属|来源/, 'ownership'],
    [/使用单位|所属工区|工区|部门|单位/, 'unit'],
    [/租赁起始|起租|租期起|租赁开始/, 'leaseStart'],
    [/租赁到期|租期止|租止|租赁结束/, 'leaseExp'],
    [/保险.*到期|保单到期/, 'insExp'],
    [/保险|保单|车险/, 'insurance'],
    [/年检.*到期|年审到期|年检|年审/, 'inspExp'],
    [/通行证.*到期|通行到期/, 'permitExp'],
    [/通行证|通行许可/, 'permit'],
    [/状态|车况|运行情况/, 'status'],
    [/驾驶员|司机|负责司机|主驾/, 'driver'],
    [/当前位置|实时位置|位置/, 'curLoc'],
    [/上报时间|位置更新/, 'locTime'],
    [/当前里程|里程|公里数/, 'mileage'],
    [/下次保养|保养日期/, 'maintDate'],
    [/备注|说明|备注说明/, 'note']
  ];
  for (const [re, key] of rules) { if (re.test(h)) return key; }
  return null;
}
function parseVehicles(text) {
  const lines = toTSV(text).replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const hi = findHeaderLine(lines, mapVehicleHeader);
  const head = lines[hi].split('\t').map((h, i) => ({ key: mapVehicleHeader(h), i }));
  const used = head.filter(h => h.key);
  if (!used.length) return [];
  const dateKeys = new Set(['insExp', 'permitExp', 'inspExp', 'leaseStart', 'leaseExp', 'locTime', 'maintDate']);
  const rows = [];
  for (let r = hi + 1; r < lines.length; r++) {
    const cells = lines[r].split('\t');
    const rec = {
      plate: '', model: '', vehClass: '', fuel: '', vin: '', ownership: '', unit: '',
      leaseStart: '', leaseExp: '', insurance: '', insExp: '', inspExp: '', permit: '',
      permitExp: '', status: '正常', driver: '', curLoc: '', locTime: '', mileage: '', maintDate: '', note: ''
    };
    for (const h of used) {
      let v = (cells[h.i] || '').trim();
      if (dateKeys.has(h.key)) v = normDate(v);
      else if (h.key === 'status') { if (/停用|闲置|报废/.test(v)) v = '停用'; else if (/保养/.test(v)) v = '保养'; else if (/维修/.test(v)) v = '维修'; else v = '正常'; }
      else if (h.key === 'ownership') { if (/租/.test(v)) v = '租赁'; else if (/购|自/.test(v)) v = '自购'; }
      rec[h.key] = v;
    }
    if (!rec.plate) continue;
    rows.push(rec);
  }
  return rows;
}

/* ============ 车辆排期（来源：WPS 在线表格「车辆排期」sheet） ============ */
function mapVehSchedHeader(h) {
  h = String(h).trim();
  const rules = [
    [/日期|排期日期|用车日期/, 'date'],
    [/车牌|车号/, 'plate'],
    [/任务|用途|事项|内容/, 'task'],
    [/驾驶人|司机|驾驶员/, 'driver'],
    [/出发|起点/, 'from'],
    [/目的地|到达|去往/, 'to'],
    [/开始|发车/, 'start'],
    [/结束|收车|止/, 'end'],
    [/备注/, 'note']
  ];
  for (const [re, key] of rules) { if (re.test(h)) return key; }
  return null;
}
function parseVehicleSched(text) {
  const lines = toTSV(text).replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const hi = findHeaderLine(lines, mapVehSchedHeader);
  const head = lines[hi].split('\t').map((h, i) => ({ key: mapVehSchedHeader(h), i }));
  const used = head.filter(h => h.key);
  if (!used.length) return [];
  const rows = [];
  for (let r = hi + 1; r < lines.length; r++) {
    const cells = lines[r].split('\t');
    const rec = { date: '', plate: '', task: '', driver: '', from: '', to: '', start: '', end: '', note: '' };
    for (const h of used) {
      let v = (cells[h.i] || '').trim();
      if (h.key === 'date') v = normDate(v);
      else if (h.key === 'start' || h.key === 'end') v = normTime(v);
      rec[h.key] = v;
    }
    if (!rec.plate && !rec.task) continue;
    rows.push(rec);
  }
  return rows;
}

module.exports = { parseTasks, parseRooms, parseVisas, parseVehicles, parseVehicleSched, parseCSV, toTSV, normDate, normTime, findHeaderLine };
