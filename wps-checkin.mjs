#!/usr/bin/env node
/* ============================================================================
 * WPS 表单自动打卡 —— 自动获取打卡围栏、自动续期登录态、可定时运行
 * ============================================================================
 *
 * 依赖：Node.js >= 18，Chromium/Chrome（无头模式即可，无需图形界面）
 *
 * 安装浏览器（任选其一）：
 *   Debian/Ubuntu:  sudo apt-get update && sudo apt-get install -y chromium
 *   或者已有 chrome:  google-chrome / chromium / chromium-browser 任一在 PATH 中
 *   也可指定：       export CHROME_PATH=/usr/bin/chromium
 *
 * 用法：
 *   node wps-checkin.mjs                 # 立即打卡（已打卡会自动跳过）
 *   node wps-checkin.mjs --status        # 只看本轮是否已打卡
 *   node wps-checkin.mjs --keepalive     # 保活/自动续期登录态
 *   node wps-checkin.mjs --install-cron  # 安装定时任务（按配置的时间打卡 + 定期保活）
 *   node wps-checkin.mjs --uninstall-cron
 *   node wps-checkin.mjs --print-cron    # 只打印将写入的 crontab，不修改
 *   node wps-checkin.mjs --import-cookie "wps_sid=...; kso_sid=...; ..."
 *   node wps-checkin.mjs --import-cookie-file /path/cookie.txt
 *   node wps-checkin.mjs --dry-run       # 只填表定位，不提交
 *   node wps-checkin.mjs --locate        # 只解析围栏并打印坐标，不启浏览器
 *
 * 退出码：0 成功/已打卡；1 失败；2 环境错误；3 未打卡；4 登录态失效
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NODE_MAJOR = Number(String(process.versions.node).split('.')[0]);
if (NODE_MAJOR < 22) {
  console.error(
    `需要 Node.js >= 22（当前 ${process.version}），因为要用内置 WebSocket 连接 Chrome。\n` +
    '升级示例：curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs\n' +
    '或使用 nvm：nvm install 22 && nvm use 22');
  process.exit(2);
}
const __filename = fileURLToPath(import.meta.url);

// ============================================================================
// 配置
// ============================================================================
const CONFIG = {
  // 必填：打卡表单链接，例如 https://f.wps.cn/ksform/cw/w/XXXXXXXX
  formUrl: '',
  // 必填：打卡人信息（也可用环境变量 WPS_NAME / WPS_STUDENT_ID 覆盖）
  name: '',
  studentId: '',
  // 自动定位：每次运行都从表单接口读取打卡围栏并计算中心点（推荐）
  autoLocation: true,
  // 围栏有多个时按名称子串挑选；留空则取第一个
  rangeName: '',
  // 自动获取失败时的兜底坐标（浏览器定位口径 WGS84）；autoLocation=false 时也用它
  latitude: null,
  longitude: null,
  accuracy: 30,
  // 定时任务：中国时区每周 weekday（0=周日）的 times 各打卡一次，每 keepaliveEveryHours 小时保活
  schedule: { weekday: 4, times: ['18:52', '19:20'], keepaliveEveryHours: 6 },
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  cookieName: 'wps_sid',
  // 手机 UA（打卡页用）
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  // 桌面 UA（WPS 账号页 / 登录态刷新用）
  desktopUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
};

const SCRIPT_PATH = process.argv[1] ? path.resolve(process.argv[1]) : __filename;
const BASE_DIR = path.dirname(SCRIPT_PATH);
const JAR_FILE = path.join(BASE_DIR, 'wps-checkin-cookies.json');
const LOG_FILE = path.join(BASE_DIR, 'wps-checkin.log');

// ---------------------------------------------------------------------------
// 本地配置：wps-checkin-config.json（含表单链接/姓名/学号，不要提交到仓库）
// 也支持环境变量覆盖：WPS_FORM_URL / WPS_NAME / WPS_STUDENT_ID / WPS_RANGE_NAME
// ---------------------------------------------------------------------------
const CONFIG_FILE = path.join(BASE_DIR, 'wps-checkin-config.json');

function loadConfig() {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; }
    catch (e) { console.error('配置文件解析失败：' + e.message); }
  }
  const merged = {
    ...CONFIG,
    ...fileCfg,
    schedule: { ...CONFIG.schedule, ...(fileCfg.schedule || {}) },
  };
  const env = process.env;
  if (env.WPS_FORM_URL) merged.formUrl = env.WPS_FORM_URL;
  if (env.WPS_NAME) merged.name = env.WPS_NAME;
  if (env.WPS_STUDENT_ID) merged.studentId = env.WPS_STUDENT_ID;
  if (env.WPS_RANGE_NAME) merged.rangeName = env.WPS_RANGE_NAME;
  if (env.WPS_AUTO_LOCATION === '0') merged.autoLocation = false;
  if (env.WPS_LAT && env.WPS_LNG) {
    merged.autoLocation = false;
    merged.latitude = Number(env.WPS_LAT);
    merged.longitude = Number(env.WPS_LNG);
  }
  if (env.WPS_ACCURACY) merged.accuracy = Number(env.WPS_ACCURACY);
  Object.assign(CONFIG, merged);
}
loadConfig();

const SEL = {
  name: '#inputclockinName',
  studentId: '#inputclockinStudentId',
  locationBox: '.src-components-clockin-questions-q-location-write-location-index__container',
  locationBtn: '.src-components-clockin-questions-q-location-write-location-index__buttonInner',
  locationBtn2: '.src-components-clockin-questions-q-location-write-location-index__defaultButton',
  submitCircle: '.src-pages-clock-components-common-clock-button-circle-index__container',
};

const SUBMITTED_RE = /无法继续打卡/;
const NOT_STARTED_RE = /打卡未开始|不在打卡(时间|时段)|打卡已结束|收集已结束|尚未开始/;
const NEED_LOGIN_RE = /需要登录才能打卡/;

// ============================================================================
// 基础工具
// ============================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: CONFIG.timezone })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { }
}

function die(msg, code = 1) {
  log('✗ ' + msg);
  process.exit(code);
}

function notify(title, message) {
  log(`通知：${title} - ${message}`);
  try {
    // Linux 桌面通知（服务器一般没有 DISPLAY，会自动跳过）
    if (process.platform === 'linux' && process.env.DISPLAY) {
      spawnSync('notify-send', [title, message], { stdio: 'ignore' });
    }
    // 可选：webhook 告警
    if (process.env.WPS_CHECKIN_WEBHOOK) {
      const u = new URL(process.env.WPS_CHECKIN_WEBHOOK);
      const body = JSON.stringify({ title, message, time: new Date().toISOString() });
      const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
      req.on('error', () => { });
      req.write(body);
      req.end();
    }
  } catch { }
}

// ============================================================================
// Cookie Jar
// ============================================================================
function loadJar() {
  try {
    if (fs.existsSync(JAR_FILE)) {
      const j = JSON.parse(fs.readFileSync(JAR_FILE, 'utf8'));
      if (j && Array.isArray(j.cookies) && j.cookies.length) return j.cookies;
    }
  } catch { }
  return [];
}

function saveJar(cookies) {
  try {
    fs.writeFileSync(JAR_FILE, JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 2), 'utf8');
  } catch (e) { log('⚠ 无法写入 Cookie 文件：' + e.message); }
}

function hasRefreshCredential(cookies) {
  return cookies.some((c) => (c.name === 'kso_sid' || c.name === '_ku') && c.value);
}

function importCookieHeader(header) {
  const jar = loadJar();
  const pairs = String(header).split(';').map((s) => s.trim()).filter(Boolean);
  let updated = 0;
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const name = p.slice(0, i).trim();
    const value = p.slice(i + 1).trim();
    if (!name) continue;
    const existing = jar.find((c) => c.name === name && c.domain === '.wps.cn');
    const httpOnly = ['wps_sid', 'kso_sid', '_ku', '_ks'].includes(name);
    if (existing) { existing.value = value; existing.httpOnly = httpOnly; updated++; }
    else { jar.push({ name, value, domain: '.wps.cn', path: '/', expires: -1, httpOnly, secure: true, sameSite: 'None' }); updated++; }
  }
  saveJar(jar);
  return updated;
}

// ============================================================================
// Chrome 查找 / 启动
// ============================================================================
function findChrome() {
  const env = process.env.CHROME_PATH || process.env.CHROME_BIN;
  if (env && fs.existsSync(env)) return env;
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    : [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
      '/usr/bin/chromium-browser', '/snap/bin/chromium', '/opt/google/chrome/chrome',
      '/usr/local/bin/chromium', '/usr/local/bin/chrome',
    ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { } }
  // PATH 查找
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'headless_shell']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  // Playwright / Puppeteer 缓存
  const caches = [
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'puppeteer'),
  ];
  for (const dir of caches) {
    try {
      const walk = (d, depth) => {
        if (depth > 4) return null;
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          let st; try { st = fs.statSync(p); } catch { continue; }
          if (st.isDirectory()) { const r = walk(p, depth + 1); if (r) return r; }
          else if (/^(chrome|headless_shell|chrome-headless-shell)$/.test(f) || /(chrome|headless_shell)$/.test(f)) return p;
        }
        return null;
      };
      const r = walk(dir, 0);
      if (r) return r;
    } catch { }
  }
  return null;
}

async function launchChrome({ headless = true, profilePrefix = 'wps-checkin' } = {}) {
  const exe = findChrome();
  if (!exe) {
    die(
      '找不到 Chromium/Chrome。请先安装：\n' +
      '  Debian/Ubuntu: sudo apt-get update && sudo apt-get install -y chromium\n' +
      '  CentOS/RHEL:   sudo yum install -y chromium\n' +
      '  或设置环境变量：export CHROME_PATH=/path/to/chrome\n' +
      '  （服务器无需图形界面，无头模式即可）', 2);
  }
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const noSandbox = isRoot || process.env.WPS_NO_SANDBOX === '1';

  const tryLaunch = async (headlessFlag) => {
    const port = 9400 + Math.floor(Math.random() * 500);
    const profile = path.join(os.tmpdir(), `${profilePrefix}-${process.pid}-${Date.now()}`);
    fs.rmSync(profile, { recursive: true, force: true });
    const args = [
      ...(headlessFlag ? [headlessFlag] : []),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--no-service-autorun',
      '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking',
      '--disable-features=Translate,MediaRouter', '--lang=zh-CN',
      '--window-size=460,900',
    ];
    if (noSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxy) args.push('--proxy-server=' + proxy);
    if (!headless) args.push('--start-maximized');

    const proc = spawn(exe, args, { stdio: 'ignore' });
    let wsUrl = null;
    for (let i = 0; i < 160 && !wsUrl; i++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) wsUrl = page.webSocketDebuggerUrl;
      } catch { }
    }
    if (!wsUrl) { try { proc.kill('SIGKILL'); } catch { } return null; }
    const cleanup = () => {
      try { proc.kill('SIGKILL'); } catch { }
      setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } }, 500);
    };
    return { proc, wsUrl, cleanup, port, exe };
  };

  // 新版 Chrome 用 --headless=new；老版本回退到 --headless
  let r = await tryLaunch(headless ? '--headless=new' : null);
  if (!r && headless) { log('--headless=new 启动失败，回退 --headless'); r = await tryLaunch('--headless'); }
  if (!r) die('Chrome 启动失败（调试端口未就绪）。若在容器中请确认已加 --no-sandbox（root 用户会自动添加）', 2);
  return r;
}

// ============================================================================
// 极简 CDP 客户端
// ============================================================================
class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('CDP 连接失败')); });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    };
    this.ws.onclose = () => { for (const p of this.pending.values()) p({ error: { message: 'CDP closed' } }); this.pending.clear(); };
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面脚本异常: ' + (r.exceptionDetails.text || ''));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { } }
}

// ============================================================================
// 登录态：校验 + 自动续期
// ============================================================================
const AUTH_CHECK_JS = `fetch('/p/auth/check', {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body:'{}'})
  .then(r => r.text()).then(t => t.slice(0, 800)).catch(e => 'ERR:' + e.message)`;

const GRANT_TOKEN_JS = `fetch('/passport/secure/api/grant_token', {
    method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
    body: JSON.stringify({grant_type:'refresh_token'})
  }).then(r => r.text()).then(t => t.slice(0, 800)).catch(e => 'ERR:' + e.message)`;

async function applyJar(cdp, cookies) {
  for (const c of cookies) {
    const p = {
      name: c.name, value: String(c.value), domain: c.domain, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly,
    };
    if (c.expires && c.expires > 0) p.expires = c.expires;
    if (c.sameSite && ['Strict', 'Lax', 'None'].includes(c.sameSite)) p.sameSite = c.sameSite;
    try { await cdp.send('Network.setCookie', p); } catch { }
  }
}

async function dumpJar(cdp) {
  const { cookies } = await cdp.send('Network.getAllCookies');
  return cookies
    .filter((c) => { const d = String(c.domain || '').replace(/^\./, ''); return d === 'wps.cn' || d.endsWith('.wps.cn'); })
    .map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
    }));
}

async function readAccountUser(cdp) {
  const raw = await cdp.eval(AUTH_CHECK_JS);
  try {
    const j = JSON.parse(raw);
    if (j && j.result === 'ok' && j.userid) return { ok: true, user: j, raw };
    return { ok: false, raw };
  } catch { return { ok: false, raw }; }
}

/**
 * 确保登录态可用：
 *  1. 注入 cookie jar
 *  2. 打开 account.wps.cn —— 页面内置 kso 账号 SDK 会按 exp/nexp 用 kso_sid 自动换新 wps_sid
 *  3. 校验 /p/auth/check
 *  4. 失败则显式调用 grant_token 再校验
 *  5. 回写最新 cookie
 */
async function ensureSession(cdp, { jar, log: lg = log, ua }) {
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (ua) await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua, platform: 'Win32', acceptLanguage: 'zh-CN,zh;q=0.9' });
  await cdp.send('Network.clearBrowserCookies');
  await applyJar(cdp, jar);

  const before = JSON.stringify(jar.map((c) => [c.name, c.value]));

  await cdp.send('Page.navigate', { url: 'https://account.wps.cn/' });
  await sleep(7000);

  let user = await readAccountUser(cdp);
  let renewed = false;
  if (!user.ok) {
    lg('会话校验未通过，尝试 grant_token 刷新…');
    const gt = await cdp.eval(GRANT_TOKEN_JS);
    lg('grant_token => ' + String(gt).slice(0, 160));
    await sleep(2500);
    user = await readAccountUser(cdp);
    renewed = user.ok;
  }

  if (user.ok) {
    await cdp.send('Page.navigate', { url: 'https://f.wps.cn/' });
    await sleep(4000);
    const u2 = await readAccountUser(cdp);
    if (u2.ok) user = u2;
  }

  const jarAfter = await dumpJar(cdp);
  if (jarAfter.length) saveJar(jarAfter);
  const changed = JSON.stringify(jarAfter.map((c) => [c.name, c.value])) !== before;
  if (changed) lg('Cookie 已更新并写回 ' + path.basename(JAR_FILE));
  return { ok: user.ok, user: user.user, renewed, cookiesUpdated: changed, jar: jarAfter };
}

// ============================================================================
// 打卡围栏：自动获取 + WGS84/GCJ-02 换算
// ============================================================================
const GCJ02 = (() => {
  const A = 6378245.0;
  const EE = 0.00669342162296594323;
  const outOfChina = (lng, lat) => lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  const tLat = (x, y) => {
    let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
    r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
    return r;
  };
  const tLon = (x, y) => {
    let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
    r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
    return r;
  };
  const wgs84ToGcj02 = (lng, lat) => {
    if (outOfChina(lng, lat)) return [lng, lat];
    let dLat = tLat(lng - 105, lat - 35);
    let dLon = tLon(lng - 105, lat - 35);
    const radLat = lat / 180 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
    dLon = (dLon * 180) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lng + dLon, lat + dLat];
  };
  const gcj02ToWgs84 = (lng, lat) => {
    if (outOfChina(lng, lat)) return [lng, lat];
    let wLng = lng;
    let wLat = lat;
    for (let i = 0; i < 30; i++) {
      const [gLng, gLat] = wgs84ToGcj02(wLng, wLat);
      wLng -= gLng - lng;
      wLat -= gLat - lat;
    }
    return [wLng, wLat];
  };
  return { wgs84ToGcj02, gcj02ToWgs84 };
})();

const shareIdFromUrl = (url) => {
  const text = String(url || '');
  const m = text.match(/\/ksform\/(?:cw\/)?w\/([A-Za-z0-9_-]+)/) || text.match(/[?&](?:sid|shareId)=([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
};

function polygonCentroid(points) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) {
    const n = points.length;
    return [points.reduce((t, q) => t + q[0], 0) / n, points.reduce((t, q) => t + q[1], 0) / n];
  }
  return [cx / (6 * area), cy / (6 * area)];
}

async function fetchCheckinRanges(shareId) {
  const res = await fetch('https://f-api.wps.cn/ksform/api/v3/campaign/' + encodeURIComponent(shareId) + '/ranges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (json.code !== 0) throw new Error('接口 code=' + json.code);
  return (json.data && json.data.items) || [];
}

// 页面把 navigator.geolocation 返回的坐标当 WGS84，转成 GCJ-02 后再与围栏比对；
// 围栏接口给的是 GCJ-02 顶点，因此要把中心点反算回 WGS84，注入后才落在围栏正中。
async function resolveCheckinLocation() {
  if (!CONFIG.autoLocation) return { source: 'config' };
  const shareId = shareIdFromUrl(CONFIG.formUrl);
  if (!shareId) { log('⚠ 无法从表单链接解析 shareId，跳过自动定位'); return { source: 'config' }; }

  let items;
  try { items = await fetchCheckinRanges(shareId); }
  catch (e) { log('⚠ 自动获取打卡围栏失败：' + e.message + '，将使用兜底坐标'); return { source: 'fallback' }; }

  const usable = items.filter((it) => it && it.config && Array.isArray(it.config.coordList) && it.config.coordList.length >= 3);
  if (!usable.length) { log('⚠ 表单未配置多边形围栏，使用兜底坐标'); return { source: 'fallback' }; }

  let pick = usable[0];
  if (CONFIG.rangeName) {
    const hit = usable.find((it) => String(it.rangeName || '').includes(CONFIG.rangeName));
    if (hit) pick = hit;
    else log('⚠ 没有名称包含「' + CONFIG.rangeName + '」的围栏，改用第一个');
  } else if (usable.length > 1) {
    log('· 检测到 ' + usable.length + ' 个围栏，使用第一个：' + (pick.rangeName || pick.rangeID));
  }

  const pts = pick.config.coordList
    .map((q) => [Number(q[0]), Number(q[1])])
    .filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
  const [centerLng, centerLat] = polygonCentroid(pts);
  const isGcj = String(pick.config.coordType || 'gcj02').toLowerCase() !== 'wgs84';
  const [lng, lat] = isGcj ? GCJ02.gcj02ToWgs84(centerLng, centerLat) : [centerLng, centerLat];

  CONFIG.latitude = Number(lat.toFixed(6));
  CONFIG.longitude = Number(lng.toFixed(6));
  log('围栏：' + (pick.rangeName || pick.rangeID) + '（' + (isGcj ? 'GCJ-02' : 'WGS84') + ' 中心 '
    + centerLat.toFixed(6) + ', ' + centerLng.toFixed(6) + '）');
  return { source: 'fence', name: pick.rangeName, center: [centerLat, centerLng], coords: [CONFIG.latitude, CONFIG.longitude] };
}

// ============================================================================
// 页面操作
// ============================================================================
async function waitFor(cdp, expr, timeoutMs = 20000, label = expr) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await cdp.eval(`!!(${expr})`)) return true; } catch { }
    await sleep(300);
  }
  log('  · 等待超时：' + label);
  return false;
}

async function clickPoint(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function clickSelector(cdp, selector) {
  const rect = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) return false;
  await clickPoint(cdp, rect.x, rect.y);
  return true;
}

async function clickText(cdp, text) {
  const rect = await cdp.eval(`(() => {
    const t = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll('div,span,button')].filter(e => (e.innerText || '').includes(t));
    if (!els.length) return null;
    const el = els[els.length - 1];
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) return false;
  await clickPoint(cdp, rect.x, rect.y);
  return true;
}

async function typeInto(cdp, selector, text) {
  await clickSelector(cdp, selector);
  await sleep(250);
  await cdp.send('Input.insertText', { text });
  await sleep(350);
  let val = await cdp.eval(`(document.querySelector(${JSON.stringify(selector)})||{}).value || ''`);
  if (val !== text) {
    log('  · insertText 未生效，改用原生 setter');
    await cdp.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(350);
    val = await cdp.eval(`(document.querySelector(${JSON.stringify(selector)})||{}).value || ''`);
  }
  if (val !== text) throw new Error(`填写「${selector}」失败（当前值 "${val}"）`);
}

async function screenshot(cdp, tag) {
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(BASE_DIR, `wps-checkin-${tag}-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    log('截图：' + file);
  } catch { }
}

const buildGeoPatch = () => `
(function(){
  const lat = ${CONFIG.latitude}, lon = ${CONFIG.longitude}, acc = ${CONFIG.accuracy};
  const pos = () => ({ coords: { latitude: lat, longitude: lon, accuracy: acc, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition = (ok) => setTimeout(() => ok(pos()), 350);
    navigator.geolocation.watchPosition = (ok) => { const t = setTimeout(() => ok(pos()), 350); return t; };
    navigator.geolocation.clearWatch = (t) => clearTimeout(t);
  }
})();`;

async function openForm(cdp) {
  await cdp.send('Page.navigate', { url: CONFIG.formUrl });
  const ok = await waitFor(cdp, `document.querySelector(${JSON.stringify(SEL.name)})`, 60000, '表单加载');
  await sleep(1500);
  return ok;
}
const readBody = async (cdp) => String(await cdp.eval('document.body.innerText'));

async function autoLocate(cdp) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`自动定位（第 ${attempt} 次）`);
    let clicked = await clickSelector(cdp, SEL.locationBtn);
    if (!clicked) clicked = await clickSelector(cdp, SEL.locationBtn2);
    if (!clicked) clicked = await clickText(cdp, '点击自动定位');
    const ok = await waitFor(cdp, `(() => {
      const el = document.querySelector(${JSON.stringify(SEL.locationBox)});
      const t = (el && el.innerText || '').replace(/\\s+/g, '');
      return t.length > 4 && !t.includes('点击自动定位');
    })()`, 25000, '定位结果');
    if (ok) return await cdp.eval(`((document.querySelector(${JSON.stringify(SEL.locationBox)})||{}).innerText || '').replace(/\\s+/g,'')`);
    await sleep(1200);
  }
  return null;
}

async function fillForm(cdp) {
  await typeInto(cdp, SEL.name, CONFIG.name);
  await typeInto(cdp, SEL.studentId, CONFIG.studentId);
  const addr = await autoLocate(cdp);
  if (!addr) log('⚠ 自动定位未返回地址：经纬度已注入，仍继续尝试打卡');
  else log('定位结果：' + addr);
  return addr;
}

async function clickSubmitAndWait(cdp) {
  log('点击「打卡」…');
  const clicked = (await clickSelector(cdp, SEL.submitCircle)) || (await clickText(cdp, '打卡'));
  if (!clicked) { await screenshot(cdp, 'submit-missing'); throw new Error('找不到打卡按钮'); }

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await sleep(900);
    const t = await readBody(cdp).catch(() => '');
    const confirm = await cdp.eval(`(() => {
      const els = [...document.querySelectorAll('button, [role="button"], .adm-button')];
      const el = els.find(e => /^(确认|确定|继续打卡|仍要提交)$/.test((e.innerText || '').trim()));
      return el ? (el.innerText || '').trim() : '';
    })()`).catch(() => '');
    if (confirm) { log('出现确认弹窗「' + confirm + '」'); await clickText(cdp, confirm); await sleep(1200); continue; }
    if (/打卡成功|提交成功|签到成功|打卡完成/.test(t)) return { ok: true, reason: '页面提示打卡成功' };
    if (NOT_STARTED_RE.test(t)) return { ok: false, reason: '不在打卡时段' };
    if (/不在打卡范围|超出打卡范围|定位不在|距离太远|定位校验失败|打卡失败|提交失败/.test(t)) {
      return { ok: false, reason: t.split('\n').filter((l) => /范围|定位|失败/.test(l)).slice(0, 2).join(' | ') };
    }
    if (SUBMITTED_RE.test(t)) return { ok: true, reason: '服务端提示本轮已打卡' };
  }
  return { ok: false, reason: '等待 90 秒未收到结果' };
}

// ============================================================================
// 主流程
// ============================================================================
async function runCheckin({ dryRun = false, statusOnly = false } = {}) {
  log('=== WPS 自动签到开始 ===');
  if (!CONFIG.formUrl) die('未配置打卡表单链接：请在 wps-checkin-config.json 填写 formUrl，或设置 WPS_FORM_URL', 2);
  if (!CONFIG.name || !CONFIG.studentId) die('未配置姓名/学号：请填写 wps-checkin-config.json，或设置 WPS_NAME / WPS_STUDENT_ID', 2);
  log(`表单：${CONFIG.formUrl}`);
  log(`姓名：${CONFIG.name}  学号：${CONFIG.studentId}`);
  if (CONFIG.autoLocation) await resolveCheckinLocation();
  if (CONFIG.latitude == null || CONFIG.longitude == null) {
    die('没有可用的定位坐标：请开启 autoLocation（推荐）或填写兜底 latitude / longitude', 2);
  }
  log(`定位：${CONFIG.latitude}, ${CONFIG.longitude}（精度 ${CONFIG.accuracy}m） ${CONFIG.timezone} ${CONFIG.locale}`);

  let jar = loadJar();
  if (!jar.length) {
    notify('WPS 自动签到', '未找到 Cookie，需要先导入登录态');
    log('✗ 未找到 ' + path.basename(JAR_FILE) + '，请先在浏览器登录 f.wps.cn，再用 --import-cookie 导入');
    return 4;
  }
  log(`已加载 Cookie：${jar.length} 条（含续期凭证：${hasRefreshCredential(jar) ? '是' : '否'}）`);

  const chrome = await launchChrome({ headless: true });
  log('Chrome：' + chrome.exe);
  const cdp = new CDP(chrome.wsUrl);
  await cdp.connect();
  try {
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: buildGeoPatch() });
    await cdp.send('Browser.grantPermissions', { origin: new URL(CONFIG.formUrl).origin, permissions: ['geolocation'] });
    await cdp.send('Emulation.setGeolocationOverride', { latitude: CONFIG.latitude, longitude: CONFIG.longitude, accuracy: CONFIG.accuracy });

    log('校验 / 续期 WPS 登录态…');
    const sess = await ensureSession(cdp, { jar, ua: CONFIG.desktopUserAgent });
    if (!sess.ok) {
      notify('WPS 自动签到', '登录态已失效，需要更新 Cookie');
      log('✗ 登录态已失效。请在浏览器重新登录 f.wps.cn，复制完整 Cookie 后用 --import-cookie 导入');
      return 4;
    }
    log(`登录态正常：${sess.user && (sess.user.nickname || '')} (userid ${sess.user && sess.user.userid})`);
    if (sess.renewed) log('本次已自动续期并保存新 Cookie');

    await cdp.send('Emulation.setUserAgentOverride', { userAgent: CONFIG.userAgent, platform: 'iPhone', acceptLanguage: `${CONFIG.locale},zh;q=0.9` });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    if (!(await openForm(cdp))) {
      await screenshot(cdp, 'load-fail');
      throw new Error('表单加载失败：' + (await readBody(cdp).catch(() => '')).slice(0, 200));
    }

    let body = await readBody(cdp);
    if (NEED_LOGIN_RE.test(body)) {
      notify('WPS 自动签到', '页面要求重新登录，需要更新 Cookie');
      log('✗ 页面提示「需要登录才能打卡」，Cookie 已失效，请 --import-cookie 更新');
      return 4;
    }
    let readOnly = await cdp.eval(`(document.querySelector(${JSON.stringify(SEL.name)})||{}).readOnly === true`);
    const already = SUBMITTED_RE.test(body) || readOnly;
    log(`页面状态：${already ? '本轮已打卡' : '可打卡'}`);

    if (already) {
      log('页面提示：' + body.split('\n').slice(0, 4).join(' | '));
      await screenshot(cdp, 'already');
      log('✓ 本轮已打卡，跳过');
      return 0;
    }
    if (statusOnly) { log('✗ 本轮尚未打卡'); return 3; }

    for (let i = 0; i < 12 && NOT_STARTED_RE.test(body); i++) {
      log('打卡尚未开始，60 秒后重试…');
      await sleep(60000);
      await openForm(cdp);
      body = await readBody(cdp);
      if (SUBMITTED_RE.test(body)) { log('✓ 已在等待期间完成打卡'); return 0; }
    }

    await fillForm(cdp);
    if (dryRun) {
      await screenshot(cdp, 'dry-run');
      log('✓ dry-run 完成：姓名 / 学号 / 定位均已就绪，未点击打卡');
      return 0;
    }

    const res = await clickSubmitAndWait(cdp);
    if (!res.ok) {
      await screenshot(cdp, 'failed');
      log('页面内容：' + (await readBody(cdp).catch(() => '')).split('\n').slice(0, 10).join(' | '));
      notify('WPS 自动签到失败', res.reason);
      throw new Error('打卡失败：' + res.reason);
    }
    log('提交结果：' + res.reason);
    await screenshot(cdp, 'success');

    log('复核打卡结果…');
    await sleep(1500);
    await openForm(cdp);
    const body2 = await readBody(cdp);
    if (SUBMITTED_RE.test(body2)) log('✓ 复核通过：本轮打卡记录已生成');
    else { await screenshot(cdp, 'verify-warn'); log('⚠ 未检测到复核标记，请人工确认（可能仍已成功）'); }
    return 0;
  } finally {
    try { const finalJar = await dumpJar(cdp); if (finalJar.length) saveJar(finalJar); } catch { }
    cdp.close();
    chrome.cleanup();
  }
}

async function runKeepalive() {
  let jar = loadJar();
  if (!jar.length) {
    log('✗ 未找到 ' + path.basename(JAR_FILE) + '，请先 --import-cookie 导入登录态');
    return 4;
  }
  log('=== WPS 登录态保活 ===');
  log(`Cookie：${jar.length} 条（含续期凭证：${hasRefreshCredential(jar) ? '是' : '否'}）`);
  const chrome = await launchChrome({ headless: true, profilePrefix: 'wps-keepalive' });
  const cdp = new CDP(chrome.wsUrl);
  await cdp.connect();
  try {
    const sess = await ensureSession(cdp, { jar, ua: CONFIG.desktopUserAgent });
    if (sess.ok) {
      log(`✓ 会话正常：${sess.user && (sess.user.nickname || '')} (userid ${sess.user && sess.user.userid})`);
      if (sess.renewed) log('✓ 已自动续期并回写 Cookie');
      else if (sess.cookiesUpdated) log('Cookie 已同步回写（会话未到期）');
      return 0;
    }
    log('✗ 会话失效，无法自动续期');
    notify('WPS 自动签到', '登录态已失效，需要更新 Cookie');
    return 4;
  } finally {
    cdp.close();
    chrome.cleanup();
  }
}

// ============================================================================
// crontab 安装
// ============================================================================
const CRON_MARK_START = '# >>> wps-checkin >>>';
const CRON_MARK_END = '# <<< wps-checkin <<<';

function cstToLocal(hour, minute, baseWeekday = 4) {
  const cstOffset = 8 * 60;
  const serverOffset = -new Date().getTimezoneOffset(); // 分钟
  let mins = hour * 60 + minute - (cstOffset - serverOffset);
  let dayShift = 0;
  while (mins < 0) { mins += 1440; dayShift -= 1; }
  while (mins >= 1440) { mins -= 1440; dayShift += 1; }
  const dow = ((baseWeekday + dayShift) % 7 + 7) % 7; // cron：0=周日
  return { hour: Math.floor(mins / 60), minute: mins % 60, dow };
}

function buildCronLines() {
  const node = process.execPath;
  const script = SCRIPT_PATH;
  const sch = CONFIG.schedule || {};
  const times = Array.isArray(sch.times) && sch.times.length ? sch.times : ['18:52', '19:20'];
  const baseWeekday = Number.isInteger(sch.weekday) ? sch.weekday : 4;
  const pad = (n) => String(n).padStart(2, '0');
  const jobs = times.map((t) => {
    const [h, m] = String(t).split(':').map(Number);
    const x = cstToLocal(h, m, baseWeekday);
    return `${pad(x.minute)} ${pad(x.hour)} * * ${x.dow} cd "${BASE_DIR}" && "${node}" "${script}" >> "${LOG_FILE}" 2>&1`;
  });
  const every = Math.max(1, Number(sch.keepaliveEveryHours) || 6);
  const keepalive = `17 */${every} * * * cd "${BASE_DIR}" && "${node}" "${script}" --keepalive >> "${LOG_FILE}" 2>&1`;
  return { lines: [...jobs, keepalive], times, every };
}

function readCrontab() {
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout;
  return '';
}

function writeCrontab(content) {
  const r = spawnSync('crontab', ['-'], { input: content, encoding: 'utf8' });
  if (r.status !== 0) die('写入 crontab 失败：' + (r.stderr || '').slice(0, 200), 2);
}

function stripCronBlock(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let skip = false;
  for (const l of lines) {
    if (l.trim() === CRON_MARK_START) { skip = true; continue; }
    if (l.trim() === CRON_MARK_END) { skip = false; continue; }
    if (!skip) out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function installCron() {
  const { lines, times, every } = buildCronLines();
  const block = [CRON_MARK_START, ...lines, CRON_MARK_END].join('\n');
  const current = stripCronBlock(readCrontab());
  const next = (current ? current + '\n\n' : '') + block + '\n';
  writeCrontab(next);
  log('✓ 已写入 crontab：');
  log('  打卡：每周 ' + times.join(' / ') + '（中国时区，已换算为服务器本地时间）');
  log('  保活：每 ' + every + ' 小时（:17）');
  log('  若服务器时区有夏令时，触发时间会前后挪 1 小时。');
}

function uninstallCron() {
  const current = readCrontab();
  if (!current.includes(CRON_MARK_START)) { log('crontab 中没有 wps-checkin 配置'); return; }
  writeCrontab(stripCronBlock(current) + '\n');
  log('✓ 已从 crontab 移除 wps-checkin');
}

function printCron() {
  const { lines } = buildCronLines();
  console.log([CRON_MARK_START, ...lines, CRON_MARK_END].join('\n'));
}

// ============================================================================
// 入口
// ============================================================================
async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const getVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

  if (has('--help') || has('-h')) { printHelp(); return 0; }

  if (has('--import-cookie')) {
    const v = getVal('--import-cookie');
    if (!v) die('用法：--import-cookie "wps_sid=...; kso_sid=...; ..."', 2);
    const n = importCookieHeader(v);
    log(`✓ 已导入/更新 ${n} 条 Cookie → ${JAR_FILE}`);
    return 0;
  }
  if (has('--import-cookie-file')) {
    const f = getVal('--import-cookie-file');
    if (!f || !fs.existsSync(f)) die('Cookie 文件不存在：' + f, 2);
    const n = importCookieHeader(fs.readFileSync(f, 'utf8').trim());
    log(`✓ 已从文件导入/更新 ${n} 条 Cookie → ${JAR_FILE}`);
    return 0;
  }
  if (has('--locate')) {
    if (!CONFIG.formUrl) die('未配置 formUrl：请填写 wps-checkin-config.json 或设置 WPS_FORM_URL', 2);
    const loc = await resolveCheckinLocation();
    if (CONFIG.latitude == null || CONFIG.longitude == null) die('无法获得定位坐标：请检查围栏配置或填写兜底坐标', 1);
    console.log(JSON.stringify({
      source: loc.source,
      range: loc.name || null,
      centerGcj02: loc.center || null,
      injectWgs84: { latitude: CONFIG.latitude, longitude: CONFIG.longitude },
      accuracy: CONFIG.accuracy,
    }, null, 2));
    return 0;
  }
  if (has('--print-cron')) { printCron(); return 0; }
  if (has('--install-cron')) { installCron(); return 0; }
  if (has('--uninstall-cron')) { uninstallCron(); return 0; }

  // 全局看门狗，防止 cron 任务卡死（仅作用于实际执行任务的模式）
  setTimeout(() => { log('✗ 超时退出'); process.exit(1); }, 10 * 60 * 1000).unref();

  if (has('--keepalive')) return runKeepalive();
  if (has('--status')) return runCheckin({ statusOnly: true });
  if (has('--dry-run')) return runCheckin({ dryRun: true });
  return runCheckin({});
}

function printHelp() {
  console.log(`WPS 表单自动打卡（单文件版）

用法：
  node ${path.basename(SCRIPT_PATH)}                立即打卡（已打卡自动跳过）
  node ${path.basename(SCRIPT_PATH)} --status       只看本轮是否已打卡
  node ${path.basename(SCRIPT_PATH)} --keepalive    保活/自动续期登录态
  node ${path.basename(SCRIPT_PATH)} --dry-run      只填表定位，不提交
  node ${path.basename(SCRIPT_PATH)} --locate       只解析打卡围栏并打印坐标
  node ${path.basename(SCRIPT_PATH)} --install-cron 安装定时任务
  node ${path.basename(SCRIPT_PATH)} --print-cron   仅打印 crontab
  node ${path.basename(SCRIPT_PATH)} --uninstall-cron 移除定时任务
  node ${path.basename(SCRIPT_PATH)} --import-cookie "wps_sid=...; kso_sid=..."
  node ${path.basename(SCRIPT_PATH)} --import-cookie-file cookie.txt

配置：
  ${path.basename(CONFIG_FILE)}   表单链接 / 姓名 / 学号 / 定时设置（勿提交到仓库）

环境变量：
  WPS_FORM_URL         打卡表单链接（覆盖配置）
  WPS_NAME             姓名（覆盖配置）
  WPS_STUDENT_ID       学号（覆盖配置）
  WPS_RANGE_NAME       多围栏时按名称子串选择
  WPS_AUTO_LOCATION=0  关闭自动定位，改用兜底坐标
  WPS_LAT / WPS_LNG    手动指定坐标（浏览器定位口径 WGS84）
  CHROME_PATH          Chromium/Chrome 路径（默认自动查找）
  WPS_NO_SANDBOX=1     容器/root 下强制 --no-sandbox（root 用户自动启用）
  HTTPS_PROXY          Chrome 代理（如 http://127.0.0.1:7890）
  WPS_CHECKIN_WEBHOOK  可选：状态变化时 POST 到该 webhook 告警
  TZ                   时区，默认 Asia/Shanghai

文件：
  ${path.basename(JAR_FILE)}    Cookie（自动维护，含登录凭证，勿外传）
  ${path.basename(LOG_FILE)}    运行日志
`);
}

main()
  .then((code) => { process.exitCode = code || 0; setTimeout(() => process.exit(process.exitCode), 800); })
  .catch((e) => {
    log('✗ ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 800);
  });
