import { chromium } from 'playwright';
import { installedChrome } from './browser-paths.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STATE_FILE = path.join(HERE, '.auth-state.json');

// Instagram's login cookies (ds_user_id, sessionid) are session cookies, which a
// normal Chrome profile drops on full quit. We save/restore them ourselves via
// Playwright's storageState so login survives across browser restarts.
export async function launchContext() {
  const browser = await chromium.launch({
    headless: false,
    executablePath: installedChrome() || chromium.executablePath(),
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return browser.newContext({
    storageState: existsSync(STATE_FILE) ? STATE_FILE : undefined,
    viewport: null,
  });
}

export async function currentUserId(context) {
  const cookies = await context.cookies('https://www.instagram.com');
  return cookies.find(c => c.name === 'ds_user_id')?.value ?? null;
}
