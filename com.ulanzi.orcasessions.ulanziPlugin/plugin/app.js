// Orca 세션 + 남은 한도 → Ulanzi 키 (Node.js 메인 서비스)
//
// 액션 세 가지
//  - 세션 슬롯 : 여러 키에 깔아 두면 Orca 세션이 키 위치 순서대로 채워진다.
//  - 더보기    : 세션이 슬롯보다 많을 때 다음 페이지로. 없으면 마지막 슬롯이 대신 한다.
//  - 남은 한도 : Claude / Codex의 5시간·주간 한도 중 남은 양.

import { UlanziApi } from './ulanzi/index.js';
import { OrcaClient, parseOptions, parseMode } from './orca.js';
import { UsageStore, METRICS } from './usage.js';
import {
  renderSession, renderEmpty, renderMore, renderError, renderMoreKey, renderNoSessions,
  renderUsageGauge, renderUsagePairGauge, sessionFrames, isAnimated, ORBIT_DELAY_MS,
  renderButton, renderOption, renderReply, toDataUrl,
} from './render.js';
import { framesToGif } from './gif.js';
import { buddyFrames, BUDDY_DELAY_MS, BUDDY_FRAMES, REACTIONS } from './buddy.js';
import { setLanguage, t } from './i18n.js';

// Ulanzi Studio가 넘기는 인자: 주소, 포트, 언어. SDK는 connect()에서야 읽으므로 기본 설정을 만들기 전에 직접 읽는다.
setLanguage(process.argv[4]);

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.orcasessions';
const A_SLOT = `${PLUGIN_UUID}.slot`;
const A_MORE = `${PLUGIN_UUID}.more`;
const A_USAGE = `${PLUGIN_UUID}.usage`;
const A_BUDDY = `${PLUGIN_UUID}.buddy`;

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
  replies: t(['continue', 'commit', '/compact'], ['계속해줘', '커밋해줘', '/compact']), // 상세 화면 빠른 답장 (최대 4개)
  savedAt: 0,
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
  let entry = makeGif && gifCache.get(dataUrl);
  // 이미 만든 GIF면 정적 그림 없이 바로 보낸다 (키마다 두 번 보내면 페이지 전환이 느려진다)
  if (entry?.gif) return $UD.setGifDataIcon(ctx, entry.gif);
  $UD.setBaseDataIcon(ctx, dataUrl);
  if (!makeGif) return;
  if (!entry) {
    entry = { gif: null };
    entry.job = makeGif().then((gif) => (entry.gif = gif));
    gifCache.set(dataUrl, entry);
    if (gifCache.size > 32) gifCache.delete(gifCache.keys().next().value);
  }
  entry.job.then((gif) => {
    if (gif && lastIcon.get(ctx) === dataUrl) $UD.setGifDataIcon(ctx, gif);
  });
}
const gifCache = new Map(); // 정적 data URL → { job: Promise<GIF base64|null>, gif: 다 만들었으면 base64 }

// 방금 끝난(done) 세션은 5분 동안, 또는 키를 눌러 확인할 때까지 DONE으로 깜빡인다.
const DONE_BLINK_MS = 5 * 60 * 1000;
const seenDone = new Set(); // `${paneKey}@${stateStartedAt}` — 확인한 완료

// ───────────────────────── 설정 ─────────────────────────

function normalizeConfig(p) {
  const c = { ...config };
  if (typeof p.orcaPath === 'string') c.orcaPath = p.orcaPath.trim();
  if (p.pollMs !== undefined) c.pollMs = clamp(Number(p.pollMs) || DEFAULT_CONFIG.pollMs, 1000, 30000);
  if (p.filter === 'agents' || p.filter === 'all') c.filter = p.filter;
  if (p.workingSec !== undefined) c.workingSec = clamp(Number(p.workingSec) || DEFAULT_CONFIG.workingSec, 1, 120);
  if (p.bringToFront !== undefined) c.bringToFront = p.bringToFront === 'off' ? 'off' : 'on';
  if (typeof p.replies === 'string') c.replies = p.replies.split('\n').map((l) => l.trim().slice(0, 500)).filter(Boolean).slice(0, 4);
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

const isAgent = (t) => !!t.agentIdentity || !!agentRowFor(t);

function cleanTitle(s) {
  return String(s || '')
    .replace(/^[\s\u2800-\u28FF✳✶✻✽✢·•*◐◓◑◒⏺●○◆◇▶►>»-]+/u, '')
    .trim();
}

function basename(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

function agentRowFor(t) {
  return agents.get(`${t.tabId}:${t.leafId}`) || (t.recordedPaneKey && agents.get(t.recordedPaneKey)) || null;
}

// 백그라운드 모니터링만 돌 때 Orca는 바깥 state를 working으로 올린다(workingMode: 'monitoring').
// 그때는 본체 턴 상태(mainAgent)를 쓴다.
const watching = (row) => row.state === 'working' && row.workingMode === 'monitoring' && !!row.mainAgent?.state;
const stateOf = (row) => (watching(row) ? row.mainAgent.state : row.state);
const sinceOf = (row) => (watching(row) ? row.mainAgent.stateStartedAt : row.stateStartedAt);

function viewFor(t, now) {
  const row = agentRowFor(t);
  const agent = String(row?.agentType || t.agentIdentity || '').toLowerCase();
  const name =
    row?.conversationName || row?.displayName || row?.taskTitle ||
    cleanTitle(t.paneTitle) || cleanTitle(t.title) || basename(t.worktreePath) || '(untitled)';

  // orphaned는 끝난 게 아니다: Orca 업데이트·재시작 뒤 살아 있는 PTY가 그래프에서 빠졌을 뿐(recordedPaneKey로 ps와 잇는다)
  if (t.exitCause || t.connected === false) {
    return { tone: 'ended', agent, name };
  }
  // Orca가 알려주는 상태가 있으면 그대로 쓴다
  if (row?.state) {
    const state = stateOf(row);
    // blocked = 도구 승인 대기(PERMIT?), waiting = AI가 낸 질문·선택지에 답 대기(CHOOSE?). Orca도 둘 다 "입력 필요"로 본다.
    if (state === 'blocked') return { tone: 'awaiting', agent, name };
    if (state === 'waiting') return { tone: 'awaiting', ask: true, agent, name };
    if (state === 'working') return { tone: 'working', agent, name };
    const doneId = requestKey(row);
    const fresh = state === 'done' && now - Number(sinceOf(row)) < DONE_BLINK_MS && !seenDone.has(doneId);
    return { tone: 'idle', agent, name, fresh, doneId, watching: watching(row) };
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
  renderSessionKeys();
  renderBuddy();
}

function renderSessionKeys() {
  const ctxs = ordered(A_SLOT);
  const moreCtxs = ordered(A_MORE);
  const now = Date.now();

  for (const ctx of [...ctxs, ...moreCtxs]) assignment.delete(ctx);

  if (detail && !lastError && renderDetail(now)) return;
  detail = null;

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

// ───────────────────────── 상세 화면 ─────────────────────────
// 세션 키를 길게 누르면 세션 슬롯·더보기 키들이 그 세션의 상세 화면이 된다(한도 키는 그대로).
// 키가 작아 글자 정보는 넣지 않고, 누르면 실제로 무언가 하는 버튼만 둔다.
//   윗줄: BACK · 세션 · OPEN · MODE(Claude만) · NEW
//   아랫줄: 승인·질문 대기 = 화면의 선택지 + ESC / 작업 중 = STOP / 쉬는 중 = 빠른 답장

const LONG_PRESS_MS = 500;
const DETAIL_IDLE_MS = 60 * 1000; // 아무것도 안 누르면 목록으로 돌아간다
const ESC = '\x1b';
const SHIFT_TAB = '\x1b[Z';

/** @type {{handle:string, touchedAt:number, screenKey:string|null, options:{n:number,label:string}[], mode:string}|null} */
let detail = null;

const requestKey = (row) => `${row.paneKey}@${sinceOf(row)}`;

/** 세션 슬롯 + 더보기 키를 실제 위치(행→열) 순으로. 상세 화면은 슬롯 순서 지정을 무시한다. */
function gridCtxs() {
  return [...keysOf(A_SLOT), ...keysOf(A_MORE)]
    .sort((a, b) => compareArrays(sortKeyFor({ key: a[1].key }), sortKeyFor({ key: b[1].key })) || a[0].localeCompare(b[0]))
    .map(([ctx]) => ctx);
}

/** 터미널 화면에서 승인 선택지와 Claude 권한 모드를 읽는다. 상태가 바뀌면(stateStartedAt) 다시 읽는다. */
function loadScreen(handle, key) {
  detail.screenKey = key;
  orca.readScreen(handle)
    .then((lines) => {
      if (detail?.screenKey !== key) return;
      detail.options = parseOptions(lines.slice(-30));
      detail.mode = parseMode(lines);
      renderSessions();
    })
    .catch(() => {});
}

/** @returns {boolean} 그렸으면 true, 세션이 사라졌거나 시간이 지나 목록으로 돌아가야 하면 false */
function renderDetail(now) {
  const t = sessions.get(detail.handle);
  if (!t || now - detail.touchedAt > DETAIL_IDLE_MS) return false;
  const row = agentRowFor(t);
  const v = viewFor(t, now);
  const key = row ? requestKey(row) : t.handle;
  if (detail.screenKey !== key) {
    detail.options = [];
    loadScreen(t.handle, key);
  }
  const agent = v.agent || 'claude';
  const isClaude = agent === 'claude';
  const cells = [
    { type: 'back', icon: renderButton({ big: '←', label: 'BACK' }) },
    { type: 'none', icon: renderSession(v), gif: isAnimated(v) && (() => framesToGif(sessionFrames(v), ORBIT_DELAY_MS)) },
    { type: 'open', icon: renderButton({ big: '↗', label: 'OPEN' }) },
    isClaude && v.tone !== 'ended'
      ? { type: 'keys', text: SHIFT_TAB, reread: true, icon: renderButton({ big: '⇄', label: detail.mode || 'MODE' }) }
      : { type: 'none', icon: renderEmpty() },
    t.worktreePath
      ? { type: 'new', agent, path: t.worktreePath, icon: renderButton({ big: '+', label: `NEW ${agent.toUpperCase()}` }) }
      : { type: 'none', icon: renderEmpty() },
  ];
  if (v.tone === 'awaiting' && row) {
    const guard = { paneKey: row.paneKey, request: requestKey(row) };
    // "Type something." · "Chat about this"는 고르면 키보드 입력이 필요해서 키에는 두지 않는다
    for (const o of detail.options.filter((o) => !/^(type something|chat about this)/i.test(o.label))) {
      cells.push({ type: 'keys', text: String(o.n), guard, icon: renderOption(o.n, o.label) });
    }
    cells.push({ type: 'keys', text: ESC, guard, icon: renderButton({ big: 'ESC', label: 'CANCEL', tone: 'danger' }) });
  } else if (v.tone === 'working') {
    cells.push({ type: 'keys', text: ESC, icon: renderButton({ big: '■', label: 'STOP', tone: 'danger' }) });
  } else if (v.tone === 'idle') {
    for (const text of config.replies) cells.push({ type: 'reply', text, icon: renderReply(text) });
  }
  gridCtxs().forEach((ctx, i) => {
    const c = cells[i];
    assignment.set(ctx, { ...(c || { type: 'none' }), detail: true, handle: t.handle });
    send(ctx, c ? c.icon : renderEmpty(), c?.gif);
  });
  return true;
}

function openDetail(handle) {
  detail = { handle, touchedAt: Date.now(), screenKey: null, options: [], mode: '' };
  renderSessions();
}

async function onDetailPress(ctx, a) {
  detail.touchedAt = Date.now();
  if (a.type === 'back') {
    detail = null;
    renderSessions();
  } else if (a.type === 'open') {
    await focusSession(ctx, a.handle);
  } else if (a.type === 'new') {
    try {
      await orca.launchAgent(a.agent, a.path);
      detail = null; // 새 세션이 목록에 들어온다
    } catch (e) {
      $UD.showAlert(ctx);
      $UD.toast(e.message);
    }
    pollSessions();
  } else if (a.type === 'reply') {
    try {
      await orca.sendPrompt(a.handle, a.text);
    } catch (e) {
      $UD.showAlert(ctx);
      $UD.logMessage(`send 실패 ${a.handle}: ${e.message}`, 'warn');
    }
    setTimeout(pollSessions, 700);
  } else if (a.type === 'keys') {
    // 보내기 직전에 Orca에 다시 물어서, 화면에 띄운 그 승인 요청이 아직 그대로일 때만 보낸다.
    if (a.guard) {
      const row = (await orca.listAgents()).get(a.guard.paneKey);
      if (!row || !['blocked', 'waiting'].includes(stateOf(row)) || requestKey(row) !== a.guard.request) {
        $UD.toast(t('The approval request changed. Check the screen again.', '승인 요청이 바뀌었습니다. 화면을 다시 확인하세요.'));
        pollSessions();
        return;
      }
    }
    try {
      await orca.sendKeys(a.handle, a.text);
    } catch (e) {
      $UD.showAlert(ctx);
      $UD.logMessage(`send 실패 ${a.handle}: ${e.message}`, 'warn');
    }
    if (a.reread) setTimeout(() => detail && loadScreen(a.handle, detail.screenKey), 400); // 바뀐 모드를 다시 읽는다
    setTimeout(pollSessions, 700);
  }
}

// ───────────────────────── 버디 (Claude 캐릭터) ─────────────────────────
// 세션 하나가 아니라 전체 상황에 반응한다. 우선순위: Orca 꺼짐 > 사람이 필요함 > 방금 끝남 > 작업 중 > 쉬는 중.
// 누르면 가장 급한 세션으로 전환한다. 급한 게 없으면(쉬는 중) 누를 때마다 다른 반응을 잠깐 보여 주고 다시 존다.

const REACTION_MS = BUDDY_FRAMES * BUDDY_DELAY_MS * 2; // GIF 두 바퀴
let reaction = null; // { kind, until }
let reactionTimer = null;

/** 가장 급한 세션 순서: 승인 대기 → 질문 대기 → 방금 끝남 → 작업 중 */
function urgentSessions(now) {
  const rank = (v) => (v.tone === 'awaiting' ? (v.ask ? 1 : 0) : v.fresh ? 2 : v.tone === 'working' ? 3 : 9);
  return order.filter((h) => sessions.has(h))
    .map((h) => ({ handle: h, v: viewFor(sessions.get(h), now) }))
    .filter((x) => rank(x.v) < 9)
    .sort((a, b) => rank(a.v) - rank(b.v));
}

function buddyState(now) {
  // 한도가 하나라도 90% 이상 쓰였으면 땀
  const sweat = ['claude', 'codex'].some((p) => Object.values(usage.get(p)?.data || {}).some((w) => w?.usedPercent >= 90));
  if (lastError) return { mood: 'offline', label: 'OFFLINE' };
  const list = urgentSessions(now);
  const count = (f) => list.filter((x) => f(x.v)).length;
  const needs = count((v) => v.tone === 'awaiting');
  if (needs) return { mood: 'needs', label: needs > 1 ? `NEEDS YOU · ${needs}` : 'NEEDS YOU', sweat };
  if (count((v) => v.fresh)) return { mood: 'done', label: 'DONE', sweat };
  const working = count((v) => v.tone === 'working');
  if (working) return { mood: 'working', label: `WORKING · ${working}`, sweat };
  if (reaction && now < reaction.until) return { mood: 'react', kind: reaction.kind, label: REACTIONS[reaction.kind], sweat };
  return { mood: 'idle', label: 'IDLE', sweat };
}

function renderBuddy() {
  const ctxs = keysOf(A_BUDDY).map(([ctx]) => ctx);
  if (!ctxs.length) return;
  const st = buddyState(Date.now());
  const frames = buddyFrames(st);
  const still = toDataUrl(frames[0]);
  for (const ctx of ctxs) send(ctx, still, () => framesToGif(frames, BUDDY_DELAY_MS));
}

function playReaction() {
  const kinds = Object.keys(REACTIONS).filter((k) => k !== reaction?.kind); // 같은 반응 연속 안 나오게
  reaction = { kind: kinds[Math.floor(Math.random() * kinds.length)], until: Date.now() + REACTION_MS };
  renderBuddy();
  clearTimeout(reactionTimer);
  reactionTimer = setTimeout(renderBuddy, REACTION_MS + 50); // 끝나면 다시 졸기
}

async function onBuddyPress(ctx) {
  if (lastError) return orca.activateApp(); // Orca가 꺼져 있으면 띄운다
  const top = urgentSessions(Date.now())[0];
  if (!top) return playReaction();
  if (top.v.fresh) seenDone.add(top.v.doneId);
  renderSessions();
  await focusSession(ctx, top.handle);
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
  renderBuddy(); // 한도에 따라 땀
}

function ensureTimers() {
  const needSessions = hasAny(A_SLOT) || hasAny(A_BUDDY);
  if (needSessions && !sessionTimer) {
    restartSessionTimer();
    pollSessions();
  }
  if (!needSessions && sessionTimer) {
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

async function focusSession(ctx, handle) {
  try {
    await orca.focusTerminal(handle);
    if (config.bringToFront === 'on') await orca.activateApp();
  } catch (e) {
    $UD.showAlert(ctx);
    $UD.logMessage(`focus 실패 ${handle}: ${e.message}`, 'warn');
    pollSessions();
  }
}

/** 길게 누름. 세션 키면 상세 화면을 열고 true. 아니면 false(뗄 때 짧게 누른 것으로 처리). */
function onLongPress(ctx) {
  const a = assignment.get(ctx);
  if (a?.type !== 'session' || a.detail) return false;
  openDetail(a.handle);
  return true;
}

// 누르기 판정: keydown/keyup이 오면 그걸로 짧게/길게를 가르고, 같은 키의 run은 무시한다.
// keydown을 한 번도 안 보낸 키(호스트가 run만 보내는 경우)는 run을 짧게 누름으로 쓴다.
const hasKeyEvents = new Set();
const longTimers = new Map();
const longFired = new Set();

$UD.onKeyDown((jsn) => {
  const ctx = jsn.context;
  if (!keys.has(ctx)) $UD.emit('add', jsn);
  hasKeyEvents.add(ctx);
  clearTimeout(longTimers.get(ctx));
  longFired.delete(ctx);
  longTimers.set(ctx, setTimeout(() => {
    longTimers.delete(ctx);
    if (onLongPress(ctx)) longFired.add(ctx);
  }, LONG_PRESS_MS));
});

$UD.onKeyUp((jsn) => {
  const ctx = jsn.context;
  clearTimeout(longTimers.get(ctx));
  longTimers.delete(ctx);
  if (!longFired.delete(ctx)) onPress(ctx).catch(() => {});
});

$UD.onRun((jsn) => {
  const ctx = jsn.context;
  if (!keys.has(ctx)) $UD.emit('add', jsn);
  if (hasKeyEvents.has(ctx)) return;
  onPress(ctx).catch(() => {});
});

async function onPress(ctx) {
  const action = actionOf(ctx);
  const a = assignment.get(ctx);
  if (detail && a?.detail) return onDetailPress(ctx, a);

  if (action === A_MORE) {
    page += 1;
    renderSessions();
    return;
  }

  if (action === A_BUDDY) return onBuddyPress(ctx);

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

  if (!a) return;
  if (a.type === 'more') {
    page += 1;
    renderSessions();
  } else if (a.type === 'error') {
    $UD.toast(lastError?.message || t('Could not connect to Orca.', 'Orca에 연결하지 못했습니다.'));
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
    await focusSession(ctx, a.handle);
  }
}

process.on('uncaughtException', (e) => {
  try {
    $UD.logMessage(`uncaught: ${e?.message || e}`, 'error');
  } catch {}
});
