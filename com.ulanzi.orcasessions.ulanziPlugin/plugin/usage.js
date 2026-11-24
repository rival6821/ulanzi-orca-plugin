// Claude Code / Codex 남은 한도 조회.
// Orca 상태 표시줄과 같은 출처를 쓴다.
//  - Claude: Claude Code 로그인 토큰(macOS 키체인) → api.anthropic.com/api/oauth/usage
//  - Codex : ~/.codex/auth.json 토큰 → chatgpt.com/backend-api/wham/usage
// 토큰은 메모리에만 두고, 각 회사의 사용량 API 말고는 어디에도 보내지 않는다.

import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { t } from './i18n.js';

const HOME = os.homedir();
const TIMEOUT_MS = 10000;

export const METRICS = {
  'claude-5h': { provider: 'claude', window: 'session', label: '5H', brand: 'claude' },
  'claude-week': { provider: 'claude', window: 'weekly', label: '7D', brand: 'claude' },
  'claude-fable-week': { provider: 'claude', window: 'fableWeekly', label: '7D', brand: 'fable' },
  'claude-pair': { provider: 'claude', pair: true, brand: 'claude' },
  'codex-5h': { provider: 'codex', window: 'session', label: '5H', brand: 'codex' },
  'codex-week': { provider: 'codex', window: 'weekly', label: '7D', brand: 'codex' },
  'codex-pair': { provider: 'codex', pair: true, brand: 'codex' },
};

export class UsageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sh(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolve({ error, stdout: String(stdout || '') })
    );
  });
}

async function getJson(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const err = new UsageError(`http_${res.status}`, `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError('network', e?.name === 'AbortError' ? t('Request timed out', '응답 시간 초과') : t('Network error', '네트워크 오류'));
  } finally {
    clearTimeout(timer);
  }
}

// 초/밀리초/ISO 문자열 모두 밀리초로
function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e10 ? n : n * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

function windowOf(raw) {
  if (!raw) return null;
  const used = Number(raw.utilization ?? raw.used_percentage ?? raw.used_percent ?? raw.percent);
  if (!Number.isFinite(used)) return null;
  return { usedPercent: Math.min(100, Math.max(0, used)), resetsAt: toMs(raw.resets_at ?? raw.reset_at) };
}

// ───────────────────────── Claude ─────────────────────────

let claudeToken = null;

async function readClaudeToken() {
  // 1) macOS 키체인 (처음 한 번 "항상 허용"을 묻는 창이 뜰 수 있음). 테스트에서는 건너뛴다.
  let raw = '';
  if (!process.env.ORCA_SESSIONS_TEST) {
    const r = await sh('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
    raw = !r.error ? r.stdout.trim() : '';
  }
  // 2) 파일 (리눅스식 저장 또는 구버전)
  if (!raw) {
    try {
      raw = await readFile(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), '.credentials.json'), 'utf8');
    } catch {
      raw = '';
    }
  }
  if (!raw) throw new UsageError('claude_no_login', t('Claude Code sign-in not found', 'Claude Code 로그인 정보를 찾지 못했습니다'));
  try {
    const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    if (token) return token;
  } catch {}
  throw new UsageError('claude_no_login', t('Could not read Claude Code sign-in', 'Claude Code 로그인 정보를 읽지 못했습니다'));
}

async function fetchClaude() {
  const call = async () =>
    getJson('https://api.anthropic.com/api/oauth/usage', {
      Authorization: `Bearer ${claudeToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.0',
    });

  if (!claudeToken) claudeToken = await readClaudeToken();
  let data;
  try {
    data = await call();
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      // Claude Code가 토큰을 갱신했을 수 있으니 한 번 다시 읽는다
      claudeToken = await readClaudeToken();
      try {
        data = await call();
      } catch (e2) {
        if (e2.status === 401 || e2.status === 403)
          throw new UsageError('claude_expired', t('Sign-in expired. Run Claude Code once', '로그인이 만료됨. Claude Code를 한 번 실행하세요'));
        throw e2;
      }
    } else throw e;
  }

  const scopedFable = Array.isArray(data?.limits)
    ? data.limits.find(
        (l) => l?.kind === 'weekly_scoped' && String(l?.scope?.model?.display_name || '').trim().toLowerCase() === 'fable'
      )
    : null;

  return {
    session: windowOf(data?.five_hour),
    weekly: windowOf(data?.seven_day),
    fableWeekly:
      windowOf(scopedFable) || windowOf(data?.fable_weekly) || windowOf(data?.fable_seven_day) || windowOf(data?.seven_day_fable),
  };
}

// ───────────────────────── Codex ─────────────────────────

async function fetchCodex() {
  const home = process.env.CODEX_HOME || path.join(HOME, '.codex');
  let auth;
  try {
    auth = JSON.parse(await readFile(path.join(home, 'auth.json'), 'utf8'));
  } catch {
    throw new UsageError('codex_no_login', t('Codex sign-in not found', 'Codex 로그인 정보를 찾지 못했습니다'));
  }
  const token = auth?.tokens?.access_token;
  if (!token) throw new UsageError('codex_no_login', t('Codex is not signed in with a ChatGPT account', 'Codex가 ChatGPT 계정으로 로그인되어 있지 않습니다'));

  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop',
  };
  if (auth.tokens.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id;

  let data;
  try {
    data = await getJson('https://chatgpt.com/backend-api/wham/usage', headers);
  } catch (e) {
    if (e.status === 401 || e.status === 403)
      throw new UsageError('codex_expired', t('Sign-in expired. Run Codex once', '로그인이 만료됨. Codex를 한 번 실행하세요'));
    throw e;
  }

  // 창 길이로 5시간/주간을 구분한다. 길이를 모르면 primary=5시간, secondary=주간.
  const wins = [data?.rate_limit?.primary_window, data?.rate_limit?.secondary_window];
  let session = null;
  let weekly = null;
  wins.forEach((w, i) => {
    const win = windowOf(w);
    if (!win) return;
    const mins = Number(w.limit_window_seconds) / 60;
    const kind = Number.isFinite(mins) && mins > 0 ? (mins <= 24 * 60 ? 'session' : 'weekly') : i === 0 ? 'session' : 'weekly';
    if (kind === 'session' && !session) session = win;
    else if (kind === 'weekly' && !weekly) weekly = win;
  });
  return { session, weekly };
}

// ───────────────────────── 캐시 + 백오프 ─────────────────────────

const FETCHERS = { claude: fetchClaude, codex: fetchCodex };

export class UsageStore {
  constructor() {
    /** provider → { data, error, updatedAt, nextAt } */
    this.state = {};
  }

  get(provider) {
    return this.state[provider] || null;
  }

  /** 필요한 provider만, 주기가 됐거나 force일 때 조회 */
  async refresh(providers, intervalMs, force = false) {
    const now = Date.now();
    await Promise.all(
      [...providers].map(async (p) => {
        const s = (this.state[p] ||= { data: null, error: null, updatedAt: 0, nextAt: 0, failures: 0 });
        if (!force && now < s.nextAt) return;
        if (s.inflight) return;
        s.inflight = true;
        try {
          s.data = await FETCHERS[p]();
          s.error = null;
          s.updatedAt = Date.now();
          s.failures = 0;
          s.nextAt = Date.now() + intervalMs;
        } catch (e) {
          s.error = { code: e.code || 'error', message: e.message || String(e) };
          s.failures += 1;
          // 429·네트워크 오류는 점점 늦게 다시 시도 (최대 30분)
          const backoff = Math.min(30 * 60000, intervalMs * 2 ** Math.min(s.failures, 4));
          s.nextAt = Date.now() + (e.code === 'http_429' || e.code === 'network' ? backoff : intervalMs);
        } finally {
          s.inflight = false;
        }
      })
    );
  }
}
