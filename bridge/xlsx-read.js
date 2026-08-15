// xlsx-read.js —— 纯 Node 零依赖的 xlsx 读取器
// 只用到内置 zlib（解压 zip 内的 deflate 流），无需安装任何 npm 包。
// 读取 Excel 的第一个工作表，返回二维数组（行→列，单元格为字符串）。
// 用途：解析从 WPS / 腾讯 导出的 xlsx 文件。

const zlib = require('zlib');
const fs = require('fs');

/* ---------- zip 解包（读 central directory） ---------- */
function readZipEntries(buf) {
  // 定位 End Of Central Directory
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法的 xlsx/zip 文件');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt16LE(eocd + 10);
  const entries = {};
  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // 读 local header 取得数据起点
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    entries[name] = { method, compSize, dataStart };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateEntry(buf, entry) {
  const slice = buf.slice(entry.dataStart, entry.dataStart + entry.compSize);
  if (entry.method === 0) return slice;            // stored
  if (entry.method === 8) return zlib.inflateRawSync(slice); // deflate
  throw new Error('不支持的压缩方式: ' + entry.method);
}

/* ---------- XML 文本工具 ---------- */
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // 十进制数字实体 &#20219; → 字符
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    // 十六进制数字实体 &#x4EFB; → 字符
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}
// 取标签之间的文本（支持跨标签的多个 <t>）
function innerText(xml, tagOpen, tagClose) {
  const out = [];
  const re = new RegExp(tagOpen + '[\\s\\S]*?' + tagClose, 'g');
  let m;
  while ((m = re.exec(xml))) {
    out.push(unescapeXml(m[0].replace(new RegExp('^' + tagOpen), '').replace(new RegExp(tagClose + '$'), '')));
  }
  return out.length ? out.join('') : unescapeXml(xml.replace(new RegExp('^' + tagOpen), '').replace(new RegExp(tagClose + '$'), ''));
}

/* ---------- 主读取 ---------- */
function readXlsxBuffer(buf) {
  const entries = readZipEntries(buf);

  // 1) 共享字符串表
  const shared = [];
  const ssKey = Object.keys(entries).find(k => /sharedStrings\.xml$/i.test(k));
  if (ssKey) {
    const xml = inflateEntry(buf, entries[ssKey]).toString('utf8');
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(xml))) {
      // 一个 <si> 内可能多个 <t>（带格式），拼接
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let t, txt = '';
      while ((t = tRe.exec(m[1]))) txt += unescapeXml(t[1]);
      shared.push(txt);
    }
  }

  // 2) 找到第一个工作表
  const sheetKey = Object.keys(entries)
    .filter(k => /^xl\/worksheets\/sheet\d*\.xml$/i.test(k))
    .sort()[0];
  if (!sheetKey) throw new Error('xlsx 中未找到工作表');
  const sheetXml = inflateEntry(buf, entries[sheetKey]).toString('utf8');

  // 3) 解析行与单元格
  const matrix = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(sheetXml))) {
    const rowXml = rm[1];
    const cells = {};
    let maxCol = 0;
    const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cRe.exec(rowXml))) {
      const attrs = cm[1];
      const body = cm[2];
      const rMatch = attrs.match(/\br="([A-Z]+)(\d+)"/);
      if (!rMatch) continue;
      const colLetters = rMatch[1];
      const colIdx = colLetterToIndex(colLetters);
      const tMatch = attrs.match(/\bt="([^"]+)"/);
      const t = tMatch ? tMatch[1] : '';
      let val = '';
      if (t === 's') {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        if (vMatch) { const idx = parseInt(vMatch[1], 10); val = shared[idx] != null ? shared[idx] : ''; }
      } else if (t === 'inlineStr') {
        const isMatch = body.match(/<is>([\s\S]*?)<\/is>/);
        if (isMatch) { const tRe2 = /<t[^>]*>([\s\S]*?)<\/t>/g; let tm; while ((tm = tRe2.exec(isMatch[1]))) val += unescapeXml(tm[1]); }
      } else {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        if (vMatch) val = unescapeXml(vMatch[1]);
      }
      cells[colIdx] = val;
      if (colIdx > maxCol) maxCol = colIdx;
    }
    const row = [];
    for (let c = 1; c <= maxCol; c++) row.push(cells[c] != null ? cells[c] : '');
    matrix.push(row);
  }
  return matrix;
}

function colLetterToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) idx = idx * 26 + (letters.charCodeAt(i) - 64);
  return idx;
}

function readXlsxFile(path) {
  return readXlsxBuffer(fs.readFileSync(path));
}

module.exports = { readXlsxBuffer, readXlsxFile, colLetterToIndex };
