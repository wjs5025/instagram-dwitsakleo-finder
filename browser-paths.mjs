import { existsSync } from 'node:fs';
import path from 'node:path';
export function chromeCandidates(platform = process.platform, env = process.env) {
  if (env.CHROME_PATH) return [env.CHROME_PATH];
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ...(env.HOME ? [path.join(env.HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')] : [])];
  if (platform === 'win32') return [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean).map(root => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}
export function installedChrome() { return chromeCandidates().find(candidate => existsSync(candidate)); }
export function urlOpenCommand(url, platform = process.platform) {
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  return [platform === 'darwin' ? 'open' : 'xdg-open', [url]];
}
