// fetchers.js —— 从 WPS / 腾讯 在线表格「自动」抓取数据
// 只读、best-effort。任一步失败都返回 {ok:false, mode, error}，由 server 回退到其他喂数据方式。
//
// 自动抓取的前提（绕过"私有表读不到"的墙）：
//   WPS  —— 二选一：
//           (A) 官方 OpenAPI：在 developer.kdocs.cn 建应用，拿到 accessToken + 文档 fileToken（最稳、长期有效）
//           (B) 浏览器 Cookie：登录金山文档后复制 Cookie 字符串（简单，但 Cookie 会过期需重填）
//   腾讯 —— 浏览器 Cookie：登录 docs.qq.com 后复制 Cookie（腾讯私有表无公开 API，只能走内部导出接口）

const http = require('http');
const https = require('https');
const fs = require('fs');
const { parseTasks, parseRooms } = require('./parse');
const { readXlsxBuffer } = require('./xlsx-read');

function fetchText(url, headers, timeoutMs, binary) {
  return new Promise((resolve, reject) => {
    let mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: headers || {}, timeout: timeoutMs || 20000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        return fetchText(next, headers, timeoutMs, binary).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (binary) resolve(Buffer.concat(chunks));
        else resolve(Buffer.concat(chunks).toString('utf-8'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
  });
}
// POST 表单（腾讯导出用）
function postForm(url, form, headers, timeoutMs) {
  const body = Object.keys(form).map(k => k + '=' + encodeURIComponent(form[k])).join('&');
  return new Promise((resolve, reject) => {
    let mod = url.startsWith('https') ? https : http;
    const u = new URL(url);
    const req = mod.request(u, {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }, headers || {}),
      timeout: timeoutMs || 25000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.write(body);
    req.end();
  });
}

// 把二维数组转成 TSV 喂给现有 parse 逻辑（复用表头识别）
function matrixToRows(matrix, parser) {
  const tsv = matrix.map(r => r.map(c => String(c == null ? '' : c)).join('\t')).join('\n');
  return parser(tsv);
}

/* =========================================================
 * WPS 抓取
 *   (A) OpenAPI：GET api.kdocs.cn/api/v1/openapi/et/:fileToken/sheets/0/cells
 *   (B) Cookie：drive.kdocs.cn 内部下载接口 → 下 xlsx → 解析
 * ========================================================= */
async function fetchWPS(cfg) {
  // (A) 官方 API
  if (cfg.fileToken && cfg.accessToken) {
    try {
      const url = 'https://api.kdocs.cn/api/v1/openapi/et/' + cfg.fileToken + '/sheets/0/cells?range=A1:Z2000';
      const txt = await fetchText(url, {
        'Authorization': 'Bearer ' + cfg.accessToken,
        'User-Agent': 'Mozilla/5.0'
      }, 25000);
      const json = JSON.parse(txt);
      const values = json && json.data && json.data.values;
      if (Array.isArray(values) && values.length >= 2) {
        const rows = matrixToRows(values, parseTasks);
        if (rows.length) return { ok: true, mode: 'wps-openapi', rows };
      }
      return { ok: false, mode: 'wps-openapi', error: 'API 返回结构异常或无数据' };
    } catch (e) {
      return { ok: false, mode: 'wps-openapi', error: e.message };
    }
  }
  // (B) Cookie 内部下载接口
  if (cfg.fileToken && cfg.cookie) {
    try {
      // 1) 拿临时下载地址
      const dl = await fetchText(
        'https://drive.kdocs.cn/api/v3/groups/0/files/' + cfg.fileToken + '/download?isblocks=false',
        { 'Cookie': cfg.cookie, 'User-Agent': 'Mozilla/5.0' }, 25000);
      let downUrl = null;
      try { downUrl = JSON.parse(dl).fileinfo.url; } catch (e) {}
      if (!downUrl) return { ok: false, mode: 'wps-cookie', error: '未取到下载地址（fileToken 可能不对，或 Cookie 已失效）' };
      // 2) 下载 xlsx
      const buf = await fetchText(downUrl, { 'Cookie': cfg.cookie, 'User-Agent': 'Mozilla/5.0' }, 30000, true);
      if (!buf || buf.length < 100) return { ok: false, mode: 'wps-cookie', error: '下载内容异常（可能 Cookie 失效）' };
      const matrix = readXlsxBuffer(buf);
      const rows = matrixToRows(matrix, parseTasks);
      if (rows.length) return { ok: true, mode: 'wps-cookie', rows };
      return { ok: false, mode: 'wps-cookie', error: 'xlsx 解析后无数据' };
    } catch (e) {
      return { ok: false, mode: 'wps-cookie', error: e.message };
    }
  }
  return { ok: false, mode: 'wps-none', error: '未配置 WPS 自动抓取（请在 config.json 填 accessToken+fileToken，或 cookie+fileToken；或用「上传/丢文件」）' };
}

/* =========================================================
 * 腾讯抓取
 *   私有表 → Cookie 调内部 export_office 导出 → 轮询进度 → 下载 xlsx → 解析
 * ========================================================= */
function extractTencentDocId(url) {
  // https://docs.qq.com/sheet/DUFNXTnBsV1pGYmZ4 → DUFNXTnBsV1pGYmZ4
  const m = String(url).match(/docs\.qq\.com\/\w+\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
async function fetchTencent(cfg) {
  if (!cfg.cookie) {
    return { ok: false, mode: 'tencent-none', error: '未配置腾讯 Cookie（请在 config.json 填 cookie，或用「上传/丢文件」）' };
  }
  const headers = {
    'Cookie': cfg.cookie,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://docs.qq.com/'
  };
  try {
    const docId = extractTencentDocId(cfg.publicLink) || cfg.docId;
    if (!docId) return { ok: false, mode: 'tencent-none', error: '无法从链接提取腾讯 docId' };
    // 1) 创建导出任务
    const exp = await postForm('https://docs.qq.com/v1/export/export_office', {
      'docId': docId,
      'version': '2',
      'exportSource': 'client',
      'format': 'xlsx',
      'exportType': '0',
      'switches': '{"embedFonts":false}'
    }, headers, 25000);
    let operationId = null;
    try { operationId = JSON.parse(exp.body).operationId; } catch (e) {}
    if (!operationId) return { ok: false, mode: 'tencent-cookie', error: '导出任务创建失败（Cookie 可能失效）' };
    // 2) 轮询进度，直到拿到 file_url
    let fileUrl = null;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const prog = await fetchText('https://docs.qq.com/v1/export/query_progress?operationId=' + operationId, headers, 20000);
      let j = null; try { j = JSON.parse(prog); } catch (e) {}
      if (j && j.file_url) { fileUrl = j.file_url; break; }
      if (j && j.progress === 100 && j.file_url) { fileUrl = j.file_url; break; }
    }
    if (!fileUrl) return { ok: false, mode: 'tencent-cookie', error: '导出超时未完成（腾讯服务端繁忙，稍后重试）' };
    // 3) 下载 xlsx
    const buf = await fetchText(fileUrl, headers, 30000, true);
    if (!buf || buf.length < 100) return { ok: false, mode: 'tencent-cookie', error: '下载内容异常' };
    const matrix = readXlsxBuffer(buf);
    const rows = matrixToRows(matrix, parseRooms);
    if (rows.length) return { ok: true, mode: 'tencent-cookie', rows };
    return { ok: false, mode: 'tencent-cookie', error: 'xlsx 解析后无数据（确认表中含表头：会议室/日期/开始/结束…）' };
  } catch (e) {
    return { ok: false, mode: 'tencent-cookie', error: e.message };
  }
}

module.exports = { fetchWPS, fetchTencent, extractTencentDocId };
