// Orca 세션 + 남은 한도 → Ulanzi 키 (Node.js 메인 서비스)
//
// 액션 세 가지
//  - 세션 슬롯 : 여러 키에 깔아 두면 Orca 세션이 키 위치 순서대로 채워진다.
//  - 더보기    : 세션이 슬롯보다 많을 때 다음 페이지로. 없으면 마지막 슬롯이 대신 한다.
//  - 남은 한도 : Claude / Codex의 5시간·주간 한도 중 남은 양.

import { UlanziApi } from './ulanzi/index.js';
import { OrcaClient } from './orca.js';
import { UsageStore, METRICS } from './usage.js';
import {
  renderSession, renderEmpty, renderMore, renderError, renderMoreKey, renderNoSessions,
  renderUsageGauge, renderUsagePairGauge, sessionFrames, isAnimated, ORBIT_DELAY_MS,
} from './render.js';
import { framesToGif } from './gif.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.orcasessions';
const A_SLOT = `${PLUGIN_UUID}.slot`;
const A_MORE = `${PLUGIN_UUID}.more`;
const A_USAGE = `${PLUGIN_UUID}.usage`;

// 남은 한도 키에 지표를 따로 정하지 않으면 키 위치 순서대로 이렇게 채운다.
// D200H 아랫줄은 넓은 시계 위젯 때문에 3칸이라, AgentDeck처럼 Codex 5H+7D를 한 키에 묶는다.
const AUTO_METRICS_3 = ['claude-5h', 'claude-week', 'codex-pair'];
const AUTO_METRICS_MORE = ['claude-5h', 'claude-week', 'codex-5h', 'codex-week', 'claude-fable-week'];

const DEFAULT_CONFIG = {
  orcaPath: '',
  pollMs: 2000,
  filter: 'agents', // agents | all
  workingSec: 5,
  bringToFront: 'on',
  usageMin: 5,
  savedAt: 0,
};

const AGENT_NAMES = {
  claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini', cursor: 'Cursor',
  copilot: 'Copilot', pi: 'Pi', amp: 'Amp', droid: 'Droid', kimi: 'Kimi', kiro: 'Kiro',
  grok: 'Grok', devin: 'Devin', qoder: 'Qoder',
};

const $UD = new UlanziApi();
const orca = new OrcaClient();
const usage = new UsageStore();

let config = { ...DEFAULT_CONFIG };

/** context → { action, key, active, slot, metric } */
const keys = new Map();
const lastIcon = new Map();
const assignment = new Map();

let order = [];
let sessions = new Map();
let agents = new Map(); // paneKey → worktree ps 에이전트 행
let lastError = null;
let lastPollAt = 0;
let page = 0;
let pageInfo = { hidden: 0, page: 0, pages: 1, total: 0 };
let piContext = null;

let sessionTimer = null;
let usageTimer = null;
let polling = false;

// ───────────────────────── 공통 ─────────────────────────

const actionOf = (ctx) => $UD.decodeContext(ctx).uuid;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function keysOf(action) {
  return [...keys.entries()].filter(([, k]) => k.action === action && k.active !== false);
}
const hasAny = (action) => [...keys.values()].some((k) => k.action === action);

/** makeGif가 있으면 정적 그림을 먼저 보내고, GIF가 준비되면 (그새 그림이 안 바뀐 경우만) 바꿔 끼운다. */
function send(ctx, dataUrl, makeGif) {
  if (lastIcon.get(ctx) === dataUrl) return;
  lastIcon.set(ctx, dataUrl);
  $UD.setBaseDataIcon(ctx, dataUrl);
  if (!makeGif) return;
  let job = gifCache.get(dataUrl);
  if (!job) {
    job = makeGif();
    gifCache.set(dataUrl, job);
    if (gifCache.size > 32) gifCache.delete(gifCache.keys().next().value);
  }
  job.then((gif) => {
    if (gif && lastIcon.get(ctx) === dataUrl) $UD.setGifDataIcon(ctx, gif);
  });
}
const gifCache = new Map(); // 정적 data URL → Promise<GIF base64|null>

// 방금 끝난(done) 세션은 1분 동안, 또는 키를 눌러 확인할 때까지 DONE으로 깜빡인다.
const DONE_BLINK_MS = 60 * 1000;
const seenDone = new Set(); // `${paneKey}@${stateStartedAt}` — 확인한 완료

// ───────────────────────── 설정 ─────────────────────────

function normalizeConfig(p) {
  const c = { ...config };
  if (typeof p.orcaPath === 'string') c.orcaPath = p.orcaPath.trim();
  if (p.pollMs !== undefined) c.pollMs = clamp(Number(p.pollMs) || DEFAULT_CONFIG.pollMs, 1000, 30000);
  if (p.filter === 'agents' || p.filter === 'all') c.filter = p.filter;
  if (p.workingSec !== undefined) c.workingSec = clamp(Number(p.workingSec) || DEFAULT_CONFIG.workingSec, 1, 120);
  if (p.bringToFront !== undefined) c.bringToFront = p.bringToFront === 'off' ? 'off' : 'on';
  if (p.usageMin !== undefined) c.usageMin = clamp(Number(p.usageMin) || DEFAULT_CONFIG.usageMin, 2, 60);
  c.savedAt = Number(p.savedAt) || c.savedAt;
  return c;
}

/** savedAt이 더 최신일 때만 적용 (여러 키가 저장한 값 중 마지막 것이 이긴다) */
function maybeApplyConfig(p, { persist = false } = {}) {
  if (!p || typeof p !== 'object') return false;
  const savedAt = Number(p.savedAt) || 0;
  if (!savedAt || savedAt <= config.savedAt) return false;

  const prev = config;
  config = normalizeConfig(p);
  orca.setCustomPath(config.orcaPath);
  if (persist) $UD.setGlobalSettings(config);
  if (prev.pollMs !== config.pollMs) restartSessionTimer();
  lastIcon.clear();
  if (hasAny(A_SLOT)) pollSessions();
  if (hasAny(A_USAGE) && prev.usageMin !== config.usageMin) refreshUsage(true);
  return true;
}

// ───────────────────────── 키 순서 ─────────────────────────

// 키 문자열(예: "1_0" = 1열 0행)의 숫자로 행 → 열 순 정렬. slot 번호를 지정했으면 그게 먼저.
function sortKeyFor(k) {
  const override = Number(k.slot);
  if (override > 0) return [0, override];
  const nums = String(k.key).match(/\d+/g)?.map(Number) || [];
  if (nums.length >= 2) {
    const col = nums[nums.length - 2];
    const row = nums[nums.length - 1];
    return [1, ...nums.slice(0, -2), row, col];
  }
  return [2, ...nums];
}

function compareArrays(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

function ordered(action) {
  return keysOf(action)
    .sort((a, b) => compareArrays(sortKeyFor(a[1]), sortKeyFor(b[1])) || a[0].localeCompare(b[0]))
    .map(([ctx]) => ctx);
}

// ───────────────────────── 세션 ─────────────────────────

const isAgent = (t) => !!t.agentIdentity || agents.has(`${t.tabId}:${t.leafId}`);

function cleanTitle(s) {
  return String(s || '')
    .replace(/^[\s\u2800-\u28FF✳✶✻✽✢·•*◐◓◑◒⏺●○◆◇▶►>»-]+/u, '')
    .trim();
}

function basename(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

function agentLabel(t) {
  if (!t.agentIdentity) return '셸';
  const id = String(t.agentIdentity).toLowerCase();
  return AGENT_NAMES[id] || id.charAt(0).toUpperCase() + id.slice(1);
}

function agentRowFor(t) {
  return agents.get(`${t.tabId}:${t.leafId}`) || (t.recordedPaneKey && agents.get(t.recordedPaneKey)) || null;
}

function viewFor(t, now) {
  const row = agentRowFor(t);
  const agent = String(row?.agentType || t.agentIdentity || '').toLowerCase();
  const name =
    row?.conversationName || row?.displayName || row?.taskTitle ||
    cleanTitle(t.paneTitle) || cleanTitle(t.title) || basename(t.worktreePath) || '(untitled)';

  if (t.exitCause || t.connected === false || t.orphaned === true) {
    return { tone: 'ended', agent, name };
  }
  // Orca가 알려주는 상태가 있으면 그대로 쓴다
  if (row?.state) {
    if (row.state === 'blocked') return { tone: 'awaiting', agent, name };
    if (row.state === 'working' || row.state === 'waiting') {
      return { tone: 'working', agent, name };
    }
    const doneId = `${row.paneKey}@${row.stateStartedAt}`;
    const fresh = row.state === 'done' && now - Number(row.stateStartedAt) < DONE_BLINK_MS && !seenDone.has(doneId);
    return { tone: 'idle', agent, name, fresh, doneId };
  }
  // 없으면 마지막 출력 시각으로만 추정 (주황 '승인 필요'는 추정으로 띄우지 않는다)
  const quietMs = t.lastOutputAt ? now - Number(t.lastOutputAt) : Infinity;
  return { tone: quietMs < config.workingSec * 1000 ? 'working' : 'idle', agent, name };
}

async function pollSessionsOnce() {
  if (polling) return;
  polling = true;
  try {
    const [{ terminals }, agentRows] = await Promise.all([orca.listTerminals(), orca.listAgents()]);
    agents = agentRows;
    const visible = terminals.filter((t) => t && t.handle && (config.filter === 'all' || isAgent(t)));
    const next = new Map(visible.map((t) => [t.handle, t]));
    order = order.filter((h) => next.has(h));
    for (const t of visible) if (!order.includes(t.handle)) order.push(t.handle);
    sessions = next;
    lastError = null;
  } catch (e) {
    lastError = { code: e.code || 'error', message: e.message || String(e) };
  } finally {
    lastPollAt = Date.now();
    polling = false;
  }
  renderSessions();
  pushStatusToPI();
}

function pollSessions() {
  pollSessionsOnce().catch(() => {});
}

function restartSessionTimer() {
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = null;
  if (hasAny(A_SLOT)) sessionTimer = setInterval(pollSessions, config.pollMs);
}

function shortError(e) {
  if (e.code === 'orca_not_found' || e.code === 'orca_path_invalid') return 'orca CLI not found';
  if (e.code === 'orca_timeout') return 'no response';
  return 'not running';
}

function renderSessions() {
  const ctxs = ordered(A_SLOT);
  const moreCtxs = ordered(A_MORE);
  const now = Date.now();

  for (const ctx of ctxs) assignment.delete(ctx);

  if (lastError) {
    ctxs.forEach((ctx, i) => {
      if (i === 0) {
        assignment.set(ctx, { type: 'error' });
        send(ctx, renderError('Orca', shortError(lastError)));
      } else {
        assignment.set(ctx, { type: 'empty' });
        send(ctx, renderEmpty());
      }
    });
    moreCtxs.forEach((ctx) => send(ctx, renderMoreKey({ hidden: 0, page: 0, pages: 1, total: 0 })));
    return;
  }

  const handles = order.filter((h) => sessions.has(h));
  const cap = ctxs.length;
  const dedicatedMore = moreCtxs.length > 0;
  // 더보기 키가 따로 있으면 슬롯 전부를 세션에 쓰고, 없으면 넘칠 때 마지막 슬롯을 더보기로 쓴다.
  const perPage = dedicatedMore ? cap : handles.length > cap && cap >= 2 ? cap - 1 : cap;
  const pages = perPage > 0 ? Math.max(1, Math.ceil(handles.length / perPage)) : 1;
  page = ((page % pages) + pages) % pages;
  const shown = handles.slice(page * perPage, page * perPage + perPage);
  const hidden = handles.length - shown.length;
  pageInfo = { hidden, page, pages, total: handles.length };

  ctxs.forEach((ctx, i) => {
    if (!dedicatedMore && pages > 1 && i === cap - 1) {
      assignment.set(ctx, { type: 'more' });
      send(ctx, renderMore(hidden));
      return;
    }
    const h = shown[i];
    if (!h) {
      assignment.set(ctx, { type: 'empty' });
      send(ctx, i === 0 && handles.length === 0 ? renderNoSessions() : renderEmpty());
      return;
    }
    assignment.set(ctx, { type: 'session', handle: h });
    const v = viewFor(sessions.get(h), now);
    send(ctx, renderSession(v), isAnimated(v) && (() => framesToGif(sessionFrames(v), ORBIT_DELAY_MS)));
  });

  moreCtxs.forEach((ctx) => send(ctx, renderMoreKey(pageInfo)));
}

// ───────────────────────── 남은 한도 ─────────────────────────

function usageMetrics() {
  // 지표를 직접 고른 키는 그대로, 나머지는 키 위치 순으로 아직 안 쓴 기본 지표를 배정
  const ctxs = ordered(A_USAGE);
  const chosen = new Set(ctxs.map((c) => keys.get(c).metric).filter((m) => METRICS[m]));
  const auto = ctxs.length <= 3 ? AUTO_METRICS_3 : AUTO_METRICS_MORE;
  const pool = auto.filter((m) => !chosen.has(m));
  const out = new Map();
  for (const ctx of ctxs) {
    const m = keys.get(ctx).metric;
    out.set(ctx, METRICS[m] ? m : pool.shift() || auto[0]);
  }
  return out;
}

async function refreshUsage(force = false) {
  const metrics = usageMetrics();
  const providers = new Set([...metrics.values()].map((m) => METRICS[m].provider));
  renderUsageKeys(); // 처음엔 "불러오는 중"
  if (providers.size === 0) return;
  await usage.refresh(providers, config.usageMin * 60000, force);
  renderUsageKeys();
  pushStatusToPI();
}

function usageRow(st, windowKey, label) {
  const win = st?.data ? st.data[windowKey] : null;
  let error = st?.error ? shortUsageError(st.error) : null;
  if (st?.data && !win && !error) error = 'not reported';
  return { label, window: win, error, updatedAt: st?.updatedAt || 0, loading: !st || (!st.updatedAt && !st.error) };
}

function shortUsageError(e) {
  if (/no_login/.test(e.code)) return 'not signed in';
  if (/expired/.test(e.code)) return 'sign-in expired';
  if (e.code === 'http_429') return 'rate limited';
  if (e.code === 'network') return 'network error';
  return 'unavailable';
}

// 한도 키를 누르면 모든 한도 키가 사용한 % ↔ 남은 %로 같이 바뀐다 (메모리에만, 재시작하면 사용한 %)
let showUsed = true;

function renderUsageKeys() {
  for (const [ctx, metric] of usageMetrics()) {
    const m = METRICS[metric];
    const st = usage.get(m.provider);
    if (m.pair) {
      send(ctx, renderUsagePairGauge(m.brand, [usageRow(st, 'session', '5H'), usageRow(st, 'weekly', '7D')], showUsed));
    } else {
      send(ctx, renderUsageGauge({ provider: m.brand, ...usageRow(st, m.window, m.label), showUsed }));
    }
  }
}

function ensureTimers() {
  if (hasAny(A_SLOT) && !sessionTimer) {
    restartSessionTimer();
    pollSessions();
  }
  if (!hasAny(A_SLOT) && sessionTimer) {
    clearInterval(sessionTimer);
    sessionTimer = null;
  }
  if (hasAny(A_USAGE) && !usageTimer) {
    // 30초마다: 초기화까지 남은 시간 갱신 + 주기가 된 것만 조회
    usageTimer = setInterval(() => refreshUsage(false).catch(() => {}), 30000);
    refreshUsage(false).catch(() => {});
  }
  if (!hasAny(A_USAGE) && usageTimer) {
    clearInterval(usageTimer);
    usageTimer = null;
  }
}

// ───────────────────────── 설정 화면과 통신 ─────────────────────────

function statusPayload(ctx) {
  const action = ctx ? actionOf(ctx) : A_SLOT;
  const k = ctx ? keys.get(ctx) : null;
  return {
    cmd: 'status',
    action,
    config,
    orcaPath: orca.resolvedPath,
    error: lastError,
    sessionCount: order.length,
    slotCount: ordered(A_SLOT).length,
    lastPollAt,
    metric: k?.metric || 'auto',
    autoMetric: action === A_USAGE ? usageMetrics().get(ctx) : null,
    usage: {
      claude: usage.get('claude') && { error: usage.get('claude').error, updatedAt: usage.get('claude').updatedAt },
      codex: usage.get('codex') && { error: usage.get('codex').error, updatedAt: usage.get('codex').updatedAt },
    },
  };
}

function pushStatusToPI() {
  if (piContext && keys.has(piContext)) $UD.sendToPropertyInspector(statusPayload(piContext), piContext);
}

// ───────────────────────── 이벤트 ─────────────────────────

$UD.connect(PLUGIN_UUID);

$UD.onConnected(() => $UD.getGlobalSettings());

$UD.onDidReceiveGlobalSettings((jsn) => maybeApplyConfig(jsn.settings || jsn.param || jsn.payload));

function rerenderAll() {
  renderSessions();
  renderUsageKeys();
}

$UD.onAdd((jsn) => {
  const ctx = jsn.context;
  const p = jsn.param || {};
  const prev = keys.get(ctx) || {};
  keys.set(ctx, {
    action: jsn.uuid,
    key: jsn.key,
    active: prev.active ?? true,
    slot: p.slot ?? prev.slot,
    metric: p.metric ?? prev.metric,
  });
  lastIcon.delete(ctx);
  maybeApplyConfig(p);
  ensureTimers();
  rerenderAll();
  // 새로 추가된 한도 키가 아직 안 불러온 provider를 쓰면 바로 조회
  if (jsn.uuid === A_USAGE) refreshUsage(false).catch(() => {});
});

$UD.onSetActive((jsn) => {
  const k = keys.get(jsn.context);
  if (!k) return;
  k.active = jsn.active !== false;
  if (k.active) lastIcon.delete(jsn.context);
  rerenderAll();
});

$UD.onClear((jsn) => {
  for (const item of jsn.param || []) {
    keys.delete(item.context);
    lastIcon.delete(item.context);
    assignment.delete(item.context);
    if (piContext === item.context) piContext = null;
  }
  ensureTimers();
  rerenderAll();
});

function onParams(jsn) {
  const ctx = jsn.context;
  const p = jsn.param || {};
  const k = keys.get(ctx);
  if (k) {
    if ('slot' in p) k.slot = p.slot;
    if ('metric' in p) k.metric = p.metric;
    lastIcon.clear();
  }
  if (!maybeApplyConfig(p, { persist: true })) rerenderAll();
  if (k?.action === A_USAGE) refreshUsage(false).catch(() => {});
  pushStatusToPI();
}

$UD.onParamFromApp(onParams);
$UD.onParamFromPlugin(onParams);

$UD.onSendToPlugin((jsn) => {
  const msg = jsn.payload || {};
  piContext = jsn.context;
  if (msg.cmd === 'refresh') {
    orca.resolvedPath = null;
    orca.env = null;
    if (hasAny(A_SLOT)) pollSessions();
    if (hasAny(A_USAGE)) refreshUsage(true).catch(() => {});
  }
  pushStatusToPI();
});

$UD.onRun(async (jsn) => {
  const ctx = jsn.context;
  if (!keys.has(ctx)) $UD.emit('add', jsn);
  const action = actionOf(ctx);

  if (action === A_MORE) {
    page += 1;
    renderSessions();
    return;
  }

  if (action === A_USAGE) {
    // 조회 오류가 있는 키는 누르면 다시 조회(토큰 갱신 후 등), 아니면 남은 % ↔ 사용한 % 전환
    const metric = usageMetrics().get(ctx);
    if (metric && usage.get(METRICS[metric].provider)?.error) {
      await refreshUsage(true);
      const err = usage.get(METRICS[metric].provider)?.error;
      if (err) $UD.toast(err.message);
      return;
    }
    showUsed = !showUsed;
    renderUsageKeys();
    return;
  }

  const a = assignment.get(ctx);
  if (!a) return;
  if (a.type === 'more') {
    page += 1;
    renderSessions();
  } else if (a.type === 'error') {
    $UD.toast(lastError?.message || 'Orca에 연결하지 못했습니다.');
    orca.resolvedPath = null;
    orca.env = null;
    pollSessions();
  } else if (a.type === 'session') {
    const t = sessions.get(a.handle);
    const v = t && viewFor(t, Date.now());
    if (v?.fresh) {
      seenDone.add(v.doneId); // 확인했으니 깜빡임을 멈춘다
      renderSessions();
    }
    try {
      await orca.focusTerminal(a.handle);
      if (config.bringToFront === 'on') await orca.activateApp();
    } catch (e) {
      $UD.showAlert(ctx);
      $UD.logMessage(`focus 실패 ${a.handle}: ${e.message}`, 'warn');
      pollSessions();
    }
  }
});

process.on('uncaughtException', (e) => {
  try {
    $UD.logMessage(`uncaught: ${e?.message || e}`, 'error');
  } catch {}
});
