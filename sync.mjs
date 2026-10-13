import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_DIR = path.join(HERE, 'data', 'debug');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const SKIP_SEGMENTS = new Set(['explore', 'accounts', 'direct', 'reels', 'stories', 'p', 'tv']);

// On a failure, save what the page actually looked like instead of guessing blind.
async function dumpDebug(page, label) {
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: path.join(DEBUG_DIR, `${label}.png`) }).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    await writeFile(path.join(DEBUG_DIR, `${label}.txt`), text.slice(0, 6000));
  } catch { /* best effort */ }
}

// Instagram is a heavy SPA: `domcontentloaded` fires before it hydrates, so
// checking for elements right after navigation can see an empty page. Give it
// a moment after the `load` event before looking for anything.
async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: 'load' }).catch(() => {});
  await delay(rand(2000, 3500));
}

// Instagram shows interstitials after login ("로그인 정보 저장", "알림 받기" 등) that
// block whatever page we actually asked for. Click through any "나중에 하기"/"Not Now".
async function dismissInterstitial(page) {
  const notNow = page.getByRole('button', { name: /나중에 하기|Not [Nn]ow/ });
  if (!(await notNow.count().catch(() => 0))) return false;
  await notNow.first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await delay(rand(500, 1000));
  return true;
}

// Fallback: the nav bar's own-profile link (aria-label "프로필"/"Profile") points at /<username>/.
async function ownUsernameFromNav(page) {
  await gotoAndSettle(page, 'https://www.instagram.com/');
  await dismissInterstitial(page);
  const link = page.getByRole('link', { name: /프로필|Profile/ }).first();
  if (!(await link.count().catch(() => 0))) return null;
  const href = await link.getAttribute('href').catch(() => null);
  return href?.match(/^\/([A-Za-z0-9_.]+)\/?$/)?.[1] ?? null;
}

async function ownUsername(page) {
  await gotoAndSettle(page, 'https://www.instagram.com/accounts/edit/');
  for (let i = 0; i < 3 && !page.url().includes('/accounts/edit'); i++) {
    if (!(await dismissInterstitial(page))) await gotoAndSettle(page, 'https://www.instagram.com/accounts/edit/');
  }
  const input = page.locator('input[name="username"]');
  try {
    await input.waitFor({ timeout: 8000 });
    const value = await input.inputValue();
    if (value?.trim()) return value.trim();
  } catch { /* fall through to nav-based fallback */ }

  const navUsername = await ownUsernameFromNav(page);
  if (navUsername) return navUsername;

  const inputs = await page.locator('input').evaluateAll(
    els => els.slice(0, 20).map(e => ({ name: e.name, ariaLabel: e.getAttribute('aria-label'), placeholder: e.placeholder }))
  ).catch(() => []);
  await dumpDebug(page, `no-username-${Date.now()}`);
  throw Error(`로그인한 계정의 사용자명을 확인하지 못했습니다 (url: ${page.url()}, inputs: ${JSON.stringify(inputs).slice(0, 400)})`);
}

async function extractRows(dialog, users) {
  const anchors = await dialog.locator('a[href^="/"]').all();
  for (const a of anchors) {
    const href = await a.getAttribute('href').catch(() => null);
    const match = href?.match(/^\/([A-Za-z0-9_.]+)\/?$/);
    if (!match || SKIP_SEGMENTS.has(match[1])) continue;
    const username = match[1];
    if (users.has(username)) continue;
    const text = (await a.textContent().catch(() => '')) ?? '';
    const trimmed = text.trim();
    users.set(username, { username, fullName: trimmed.startsWith(username) ? trimmed.slice(username.length).trim() : trimmed });
  }
}

// Parses header counts like "315", "1,234", "1.2만", "3.4K".
function parseCount(raw) {
  const m = raw?.match(/([\d.,]+)\s*([만천KkMm])?/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(n)) return null;
  const unit = { '만': 1e4, '천': 1e3, K: 1e3, k: 1e3, M: 1e6, m: 1e6 }[m[2]] ?? 1;
  return Math.round(n * unit);
}

async function collectFromModal(page, textPattern, countPattern, onProgress) {
  const headerScope = (await page.locator('header').count().catch(() => 0)) ? page.locator('header') : page;
  const trigger = headerScope.getByText(textPattern).first();
  if (!(await trigger.count().catch(() => 0))) {
    await dumpDebug(page, `no-trigger-${Date.now()}`);
    throw Error(`목록 버튼을 찾지 못했습니다 (패턴: ${textPattern}, url: ${page.url()})`);
  }
  const headerText = await headerScope.innerText().catch(() => '');
  const expected = parseCount(headerText.match(countPattern)?.[1]);
  await trigger.click({ timeout: 8000 }).catch(async () => { await trigger.click({ timeout: 8000, force: true }); });
  const dialog = page.locator('div[role="dialog"]').last();
  try { await dialog.waitFor({ timeout: 15000 }); }
  catch {
    await dumpDebug(page, `no-dialog-${Date.now()}`);
    throw Error(`목록 팝업이 뜨지 않았습니다 (패턴: ${textPattern}, url: ${page.url()})`);
  }
  await delay(rand(800, 1500));

  const users = new Map();
  await extractRows(dialog, users);

  const box = await dialog.boundingBox();
  const cx = box ? box.x + box.width / 2 : 400;
  const cy = box ? box.y + box.height / 2 : 400;

  // The header count can disagree with what the popup actually serves (deleted or
  // restricted accounts, count lag), and the popup may append "suggested" rows after
  // the real list, so don't rely on growth alone: stop at the header count, after a
  // stall, or after a hard time cap.
  const deadline = Date.now() + 8 * 60 * 1000;
  let stall = 0;
  for (let i = 0; i < 4000 && stall < 10 && Date.now() < deadline; i++) {
    if (expected && users.size >= expected) break;
    const before = users.size;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, rand(400, 800));
    await delay(rand(500, 1000));
    await extractRows(dialog, users);
    if (users.size === before && !(expected && users.size >= expected)) {
      await delay(rand(1200, 2200));
      await extractRows(dialog, users);
    }
    onProgress?.(users.size);
    stall = users.size > before ? 0 : stall + 1;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  await delay(rand(1000, 1800));
  return [...users.values()];
}

export async function runSync(page, onProgress) {
  const username = await ownUsername(page);
  await gotoAndSettle(page, `https://www.instagram.com/${encodeURIComponent(username)}/`);
  await dismissInterstitial(page);

  const followers = await collectFromModal(page, /팔로워|[Ff]ollowers/, /(?:팔로워|[Ff]ollowers)\s*([\d.,]+\s*[만천KkMm]?)/, count => onProgress?.('followers', count));
  await delay(rand(1500, 3000));
  const following = await collectFromModal(page, /팔로잉|팔로우\s*\d|[Ff]ollowing/, /(?:팔로잉|팔로우|[Ff]ollowing)\s*([\d.,]+\s*[만천KkMm]?)/, count => onProgress?.('following', count));

  const followerNames = new Set(followers.map(u => u.username));
  const notFollowingBack = following
    .filter(u => !followerNames.has(u.username))
    .sort((a, b) => a.username.localeCompare(b.username));

  return {
    generatedAt: new Date().toISOString(),
    followersCount: followers.length,
    followingCount: following.length,
    notFollowingBackCount: notFollowingBack.length,
    users: notFollowingBack,
  };
}
