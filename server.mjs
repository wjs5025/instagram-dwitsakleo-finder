import http from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { urlOpenCommand } from './browser-paths.mjs';
import { launchContext, currentUserId, STATE_FILE } from './browser.mjs';
import { runSync } from './sync.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, 'data');
const RESULT_FILE = path.join(DATA_DIR, 'not-following-back.json');
const PORT = 43220;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let state = { phase: 'idle', message: '', progress: null, result: null };
let running = false;
const setState = patch => { state = { ...state, ...patch, updatedAt: Date.now() }; };

try { setState({ phase: 'done', message: '이전 결과', result: JSON.parse(await readFile(RESULT_FILE, 'utf8')) }); }
catch { /* no cached result yet */ }

async function orchestrate() {
  if (running) return;
  running = true;
  setState({ phase: 'connecting', message: '브라우저를 여는 중...', progress: null });
  let context;
  try {
    context = await launchContext();
    let userId = await currentUserId(context);
    const page = context.pages()[0] ?? await context.newPage();

    if (!userId) {
      setState({ phase: 'login-required', message: '열린 브라우저 창에서 인스타그램에 로그인하세요.' });
      await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.bringToFront();
      for (let i = 0; i < 600 && !userId; i++) { await delay(1000); userId = await currentUserId(context); }
      if (!userId) throw Error('로그인이 확인되지 않았습니다. 다시 시도하세요.');
      await context.storageState({ path: STATE_FILE });
    }

    setState({ phase: 'fetching-followers', message: '팔로워 목록 수집 중... (화면을 스크롤합니다)', progress: { kind: 'followers', count: 0 } });
    const result = await runSync(page, (kind, count) => {
      setState({
        phase: kind === 'followers' ? 'fetching-followers' : 'fetching-following',
        message: kind === 'followers' ? '팔로워 목록 수집 중... (화면을 스크롤합니다)' : '팔로잉 목록 수집 중... (화면을 스크롤합니다)',
        progress: { kind, count },
      });
    });

    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    await writeFile(RESULT_FILE, JSON.stringify(result, null, 2));
    setState({ phase: 'done', message: '완료', progress: null, result });
  } catch (e) {
    setState({ phase: 'error', message: e.message, progress: null });
  } finally {
    await context?.storageState({ path: STATE_FILE }).catch(() => {});
    await context?.browser()?.close().catch(() => {});
    running = false;
  }
}

async function logout() {
  if (running) throw Error('진행 중에는 로그아웃할 수 없습니다.');
  await rm(STATE_FILE, { force: true });
  await rm(RESULT_FILE, { force: true }).catch(() => {});
  setState({ phase: 'idle', message: '로그아웃되었습니다. 다른 계정으로 로그인할 수 있습니다.', progress: null, result: null });
}

const token = randomBytes(32).toString('hex');
let origin;

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return json(403, { error: '이 컴퓨터의 대시보드에서만 사용할 수 있습니다.' });
  try {
    const route = new URL(req.url, origin).pathname;
    if (req.method === 'GET' && route === '/api/bootstrap') return json(200, { token, ...state });
    if (req.method === 'GET' && route === '/api/status') return json(200, state);
    const authed = req.headers.origin === origin && req.headers['x-gui-token'] === token;
    if (req.method === 'POST' && route === '/api/start') {
      if (!authed) return json(403, { error: '화면을 새로고침한 뒤 다시 시도하세요.' });
      orchestrate();
      return json(200, state);
    }
    if (req.method === 'POST' && route === '/api/logout') {
      if (!authed) return json(403, { error: '화면을 새로고침한 뒤 다시 시도하세요.' });
      try { await logout(); return json(200, state); } catch (e) { return json(409, { error: e.message }); }
    }
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    if (req.method === 'GET' && assets[route]) {
      const [name, mime] = assets[route];
      const content = await readFile(path.join(HERE, 'ui', name));
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
      return res.end(content);
    }
    return json(404, { error: '페이지를 찾을 수 없습니다.' });
  } catch (e) { json(500, { error: e.message }); }
});

await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
origin = `http://127.0.0.1:${server.address().port}`;
console.log(`뒷삭러 찾기 for Instagram: ${origin}`);
const [cmd, args] = urlOpenCommand(origin);
spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
