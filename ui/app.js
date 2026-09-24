const statusText = document.getElementById('statusText');
const startBtn = document.getElementById('startBtn');
const logoutBtn = document.getElementById('logoutBtn');
const resultSection = document.getElementById('resultSection');
const metaEl = document.getElementById('meta');
const rowsEl = document.getElementById('rows');
const searchEl = document.getElementById('search');

let token = null;
let users = [];
let polling = null;

const PHASE_TEXT = {
  idle: '시작하기를 누르면 브라우저 로그인부터 결과 확인까지 자동으로 진행됩니다.',
  connecting: '브라우저에 연결하는 중...',
  'login-required': '열린 브라우저 창에서 인스타그램에 로그인하세요 (2단계 인증 포함). 로그인하면 자동으로 이어집니다.',
  'fetching-followers': '팔로워 목록 수집 중... (화면을 스크롤합니다, 잠시만요)',
  'fetching-following': '팔로잉 목록 수집 중... (화면을 스크롤합니다, 잠시만요)',
  error: '오류가 발생했습니다.',
};

const BUSY_PHASES = new Set(['connecting', 'login-required', 'fetching-followers', 'fetching-following']);

function renderRows(filter = '') {
  const term = filter.trim().toLowerCase();
  const filtered = term ? users.filter(u => u.username.toLowerCase().includes(term) || u.fullName.toLowerCase().includes(term)) : users;
  rowsEl.innerHTML = filtered.map(u => `
    <tr>
      <td>${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.fullName)}</td>
      <td><a class="profile-link" href="https://www.instagram.com/${encodeURIComponent(u.username)}/" target="_blank" rel="noopener noreferrer">프로필</a></td>
    </tr>`).join('');
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function applyState(state) {
  const phase = state.phase;
  startBtn.disabled = BUSY_PHASES.has(phase);
  startBtn.textContent = phase === 'done' ? '다시 수집' : phase === 'error' ? '다시 시도' : '시작하기';
  logoutBtn.disabled = BUSY_PHASES.has(phase);

  if (phase === 'fetching-followers' || phase === 'fetching-following') {
    statusText.textContent = `${PHASE_TEXT[phase]} (${state.progress?.count ?? 0}명)`;
  } else if (phase === 'error') {
    statusText.textContent = `${PHASE_TEXT.error} ${state.message ?? ''}`;
  } else if (phase === 'done') {
    statusText.textContent = '';
  } else {
    statusText.textContent = PHASE_TEXT[phase] ?? state.message ?? '';
  }

  if (phase === 'done' && state.result) {
    users = state.result.users ?? [];
    metaEl.textContent = `팔로잉 ${state.result.followingCount}명 중 ${state.result.notFollowingBackCount}명이 맞팔하지 않음 · ${new Date(state.result.generatedAt).toLocaleString('ko-KR')} 기준`;
    resultSection.hidden = false;
    renderRows(searchEl.value);
  } else if (phase !== 'done') {
    resultSection.hidden = true;
  }
}

async function poll() {
  const res = await fetch('/api/status');
  applyState(await res.json());
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  await fetch('/api/start', { method: 'POST', headers: { 'X-GUI-Token': token } });
  poll();
});

logoutBtn.addEventListener('click', async () => {
  if (!confirm('로그아웃하고 저장된 로그인 세션과 결과를 지울까요? 다른 계정으로 다시 로그인할 수 있습니다.')) return;
  logoutBtn.disabled = true;
  const res = await fetch('/api/logout', { method: 'POST', headers: { 'X-GUI-Token': token } });
  applyState(await res.json());
});

searchEl.addEventListener('input', () => renderRows(searchEl.value));

(async () => {
  const res = await fetch('/api/bootstrap');
  const state = await res.json();
  token = state.token;
  applyState(state);
  polling = setInterval(poll, 1500);
})();
