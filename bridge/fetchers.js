// fetchers.js —— 从 WPS / 腾讯 在线表格抓取数据
// 只读、best-effort。任一步失败都返回 {ok:false, mode, error}，由 server 回退到其他喂数据方式。

const http = require('http');
const https = require('https');
const { parseTasks, parseRooms } = require('./parse');

function fetchText(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: headers || {}, timeout: timeoutMs || 20000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随一次重定向（公开导出链接常见）
        return fetchText(res.headers.location, headers, timeoutMs).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
  });
}

/* ---------- 解析浏览器复制/公开页 HTML 里的 <table> ---------- */
function htmlTableToTSV(html) {
  const m = html.match(/<table[\s\S]*?<\/table>/i);
  if (!m) return null;
  return m[0]
    .replace(/<tr[\s\S]*?>/gi, '\n')
    .replace(/<t[hd][\s\S]*?>/gi, '\t')
    .replace(/<\/t[hd]>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/* =========================================================
 * WPS 抓取
 *  方式 A（推荐）：WPS 开放平台 OpenAPI，file_token 来自 kdocs.cn/l/<token>
 *  方式 B：公开分享链接直接抓 HTML 内嵌表格（best-effort）
 * ========================================================= */
async function fetchWPS(cfg) {
  // 方式 A：官方 API（需 access_token，填在 config.json）
  if (cfg.apiToken) {
    try {
      const token = cfg.fileToken;
      const base = 'https://api.kdocs.cn/api/v1/openapi/et/' + token + '/sheets/0/cells?range=A1:Z2000';
      const txt = await fetchText(base, {
        'Authorization': 'Bearer ' + cfg.apiToken,
        'User-Agent': 'Mozilla/5.0'
      }, 25000);
      const json = JSON.parse(txt);
      // 官方返回结构为 { data: { values: [[...]] } }，首行为表头
      const values = json && json.data && json.data.values;
      if (Array.isArray(values) && values.length >= 2) {
        const tsv = values.map(r => r.map(c => (c == null ? '' : String(c))).join('\t')).join('\n');
        const rows = parseTasks(tsv);
        if (rows.length) return { ok: true, mode: 'wps-api', rows, raw: tsv };
      }
      return { ok: false, mode: 'wps-api', error: 'API 返回结构异常或无数据' };
    } catch (e) {
      return { ok: false, mode: 'wps-api', error: e.message };
    }
  }
  // 方式 B：公开链接抓 HTML
  if (cfg.publicLink) {
    try {
      const html = await fetchText(cfg.publicLink, { 'User-Agent': 'Mozilla/5.0' }, 25000);
      const tsv = htmlTableToTSV(html);
      if (tsv) {
        const rows = parseTasks(tsv);
        if (rows.length) return { ok: true, mode: 'wps-public', rows, raw: tsv };
      }
      return { ok: false, mode: 'wps-public', error: '公开链接未内嵌可解析表格（可能仍是私有/登录页，或非分享可读状态）' };
    } catch (e) {
      return { ok: false, mode: 'wps-public', error: e.message };
    }
  }
  return { ok: false, mode: 'wps-none', error: '未配置 WPS 抓取方式（可在 config.json 填 apiToken 或 publicLink，或改用「丢文件 / 浏览器上传」）' };
}

/* =========================================================
 * 腾讯抓取
 *  方式 B：公开分享链接直接抓 HTML（best-effort，最省事但常失败）
 *  （说明：腾讯导出需登录态 cookie 走 /v1/export/export_office，
 *   已预留 cookies 字段；自填写后更稳，但 cookie 有时效需定期更新。）
 * ========================================================= */
async function fetchTencent(cfg) {
  if (cfg.publicLink) {
    try {
      const headers = { 'User-Agent': 'Mozilla/5.0' };
      if (cfg.cookies) headers['Cookie'] = cfg.cookies;
      const html = await fetchText(cfg.publicLink, headers, 25000);
      const tsv = htmlTableToTSV(html);
      if (tsv) {
        const rows = parseRooms(tsv);
        if (rows.length) return { ok: true, mode: 'tencent-public', rows, raw: tsv };
      }
      return { ok: false, mode: 'tencent-public', error: '公开链接未内嵌可解析表格（腾讯表格数据由脚本动态加载，私有/登录表无法免登读取）' };
    } catch (e) {
      return { ok: false, mode: 'tencent-public', error: e.message };
    }
  }
  return { ok: false, mode: 'tencent-none', error: '未配置腾讯抓取方式（建议用「丢文件 / 浏览器上传」最稳，或填 publicLink 试公开链接）' };
}

module.exports = { fetchWPS, fetchTencent };
