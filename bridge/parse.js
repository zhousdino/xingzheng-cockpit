// parse.js —— 表格文本解析（与驾驶舱前端逻辑保持一致）
// 支持 TSV（从表格复制）与 CSV（逗号，含引号转义）

function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inq = false; }
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

/* ---------- 任务（来源：WPS 在线表格） ---------- */
function mapHeader(h) {
  h = String(h).trim();
  const rules = [
    [/任务名称|任务名|事项/, 'name'],
    [/大类|类别|分类/, 'category'],
    [/备注|子项|说明/, 'note'],
    [/负责人/, 'owner'],
    [/协同/, 'collab'],
    [/状态/, 'status'],
    [/进度/, 'progress'],
    [/开始/, 'start'],
    [/截止|到期/, 'deadline'],
    [/优先级|紧急/, 'priority'],
    [/堵点|卡点|阻碍/, 'blocker'],
    [/更新/, 'update'],
    [/逾期/, 'overdue']
  ];
  for (const [re, key] of rules) { if (re.test(h)) return key; }
  return null;
}
function parseTasks(text) {
  const tsv = toTSV(text).replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (tsv.length < 2) return [];
  const head = tsv[0].split('\t').map((h, i) => ({ key: mapHeader(h), i }));
  const used = head.filter(h => h.key);
  const rows = [];
  for (let r = 1; r < tsv.length; r++) {
    const cells = tsv[r].split('\t');
    const rec = { name: '', category: '', note: '', owner: '', collab: '', status: '未开始', progress: 0, start: '', deadline: '', priority: '', blocker: '', update: '' };
    for (const h of used) {
      let v = (cells[h.i] || '').trim();
      if (h.key === 'progress') v = parseInt(v) || 0;
      rec[h.key] = v;
    }
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
    [/预约人|预订人|申请人|预定人|部门/, 'booker'],
    [/用途|会议主题|事项|内容|主题/, 'purpose'],
    [/状态/, 'status']
  ];
  for (const [re, key] of rules) { if (re.test(h)) return key; }
  return null;
}
function parseRooms(text) {
  const tsv = toTSV(text).replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (tsv.length < 2) return [];
  const head = tsv[0].split('\t').map((h, i) => ({ key: mapRoomHeader(h), i }));
  const used = head.filter(h => h.key);
  const rows = [];
  for (let r = 1; r < tsv.length; r++) {
    const cells = tsv[r].split('\t');
    const rec = { room: '', date: '', start: '', end: '', booker: '', purpose: '', status: '' };
    for (const h of used) {
      const v = (cells[h.i] || '').trim();
      if (h.key === 'span') {
        const mm = v.match(/(\d{1,2}:\d{2})\s*[-–—~]\s*(\d{1,2}:\d{2})/);
        if (mm) { rec.start = mm[1]; rec.end = mm[2]; }
      } else {
        rec[h.key] = v;
      }
    }
    if (!rec.room) continue;
    rows.push(rec);
  }
  return rows;
}

module.exports = { parseTasks, parseRooms, parseCSV, toTSV };
