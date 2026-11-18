// 키 이미지(SVG) 렌더러.
//
// 시각 디자인은 AgentDeck(https://github.com/puritysb/AgentDeck, MIT License,
// Copyright (c) 2025 SerendipityBound)의 D200H 렌더러
// (shared/src/svg-renderers/session-slot-renderer.ts, shared/src/d200h-layout.ts)와
// 디자인 토큰(design/tokens.css)을 옮겨 온 것이다. 라이선스 전문은 THIRD-PARTY-NOTICES.md.
// 브랜드 로고 대신 에이전트 이름과 브랜드 색만 쓴다.

const SIZE = 144;

// ── 디자인 토큰 (AgentDeck design/tokens.css) ──
const UI = {
  ok: '#52D988', attn: '#FFA93D', error: '#FF6B6B', cyan: '#3ED6E8', idleDark: '#7a8a9c',
  popupBgMid: '#0a1520', ttyDim: '#7a8493', ttyFaint: '#4a5060', hudText: '#E2E8F0', hudSubtext: '#94A3B8',
};
const TIDE_50 = '#f5f3ec';
const WORKING = '#2DD4BF';

const FONT_UI = `Inter, -apple-system, 'Apple SD Gothic Neo', system-ui, 'Helvetica Neue', 'Noto Sans CJK KR', sans-serif`;
const FONT_MONO = `'JetBrains Mono', 'SF Mono', Menlo, monospace`;
const FONT_NUM = `Arial, 'Helvetica Neue', sans-serif`;
const FONT_PLEX = `'IBM Plex Sans', -apple-system, 'Helvetica Neue', sans-serif`;

// 어두운 화면에서 쓰는 에이전트 강조색 (AgentDeck agentSlotAccent)
const AGENT_ACCENT = {
  claude: '#D97757', codex: '#8BA4FF', opencode: '#F1ECEC', kiro: '#A78BFA',
  antigravity: '#9AA0A6', gemini: '#8AB4F8',
};
export const agentAccent = (id) => AGENT_ACCENT[String(id || '').toLowerCase()] || '#B8BEC8';

// ── 텍스트 유틸 ──
function esc(s) {
  return String(s ?? '')
    // 제어 문자는 SVG 전체를 깨뜨리므로 제거
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function charEm(ch) {
  const c = ch.codePointAt(0);
  if (c === 32) return 0.28;
  if ((c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || c >= 0x1f300) return 1.0;
  if (ch === '%') return 0.9;
  if (/[MW]/.test(ch)) return 0.9;
  if (/[mw]/.test(ch)) return 0.85;
  if (/[0-9]/.test(ch)) return 0.58;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[iljtf.,:;'|!]/.test(ch)) return 0.3;
  return 0.56;
}
const textW = (s, size) => [...String(s)].reduce((w, ch) => w + charEm(ch), 0) * size;

function fit(s, maxW, size) {
  s = String(s ?? '');
  if (textW(s, size) <= maxW) return s;
  let out = '';
  for (const ch of s) {
    if (textW(out + ch + '…', size) > maxW) break;
    out += ch;
  }
  return out.trimEnd() + '…';
}

function wrapByWidth(str, maxW, size, maxLines) {
  const words = String(str).split(/(\s+)/).filter(Boolean);
  const lines = [];
  let line = '';
  const push = () => { lines.push(line.trim()); line = ''; };
  for (const w of words) {
    if (textW(line + w, size) <= maxW) { line += w; continue; }
    if (line.trim()) push();
    if (/^\s+$/.test(w)) continue;
    if (textW(w, size) <= maxW) { line = w; continue; }
    for (const ch of w) {
      if (textW(line + ch, size) > maxW) push();
      line += ch;
    }
  }
  if (line.trim()) push();
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fit(kept[maxLines - 1] + ' ' + lines.slice(maxLines).join(' '), maxW, size);
    return kept;
  }
  return lines;
}

export const toDataUrl = (svg) => 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`;

// ── 공통 프레임 (AgentDeck svgFrame) ──
function svgFrame(bg, inner) {
  const id = `frame-bg-${bg.replace(/[^a-zA-Z0-9]/g, '')}`;
  return svgOpen +
    `<defs><linearGradient id="${id}" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="${bg}"/><stop offset="100%" stop-color="#0A0A0E"/></linearGradient></defs>` +
    `<rect width="${SIZE}" height="${SIZE}" rx="16" fill="url(#${id})"/>` +
    `<rect x="8" y="8" width="128" height="128" rx="12" fill="#2C2C2E" opacity="0.6"/>` +
    inner + `</svg>`;
}

// ── 상태 카드 (AgentDeck renderStatusCard / toneColors / renderGlyphIcon 일부) ──
const TONES = {
  info: { bg: '#0b1626', panel: '#12223a', icon: '#bfdbfe', accent: '#60a5fa', text: '#dbeafe', sub: '#93c5fd' },
  muted: { bg: '#0a0a0c', panel: '#17171a', icon: '#a1a1aa', accent: '#52525b', text: '#e4e4e7', sub: '#a1a1aa' },
  brand: { bg: '#071a1e', panel: '#0e2e33', icon: '#3ED6E8', accent: '#3ED6E8', text: '#e6f7fa', sub: '#7fb2bc' },
  danger: { bg: '#1c0c0c', panel: '#341312', icon: '#fca5a5', accent: '#ef4444', text: '#fee2e2', sub: '#fca5a5' },
};

function glyph(kind, color, accent, x = 72, y = 43, s = 1) {
  const sx = (n) => x + n * s;
  const sy = (n) => y + n * s;
  const common = `stroke="${color}" stroke-linecap="round" stroke-linejoin="round"`;
  const accentStroke = `stroke="${accent}" stroke-linecap="round" stroke-linejoin="round"`;
  switch (kind) {
    case 'more':
      return `<path d="M${sx(-18)} ${sy(-15)} L${sx(0)} ${y} L${sx(-18)} ${sy(15)} M${sx(3)} ${sy(-15)} L${sx(21)} ${y} L${sx(3)} ${sy(15)}" ${common} stroke-width="${4.5 * s}" fill="none"/>`;
    case 'offline':
      return `<circle cx="${x}" cy="${y}" r="${25 * s}" fill="${accent}" opacity="0.14" stroke="${color}" stroke-width="${2.4 * s}"/><circle cx="${x}" cy="${y}" r="${4.5 * s}" fill="${color}"/><path d="M${x} ${sy(5)} V${sy(17)} M${sx(-16)} ${sy(18)} H${sx(16)}" ${accentStroke} stroke-width="${2.6 * s}" opacity="0.68"/>`;
    case 'no-session':
    default:
      return `<path d="M${sx(-25)} ${sy(-3)} H${sx(25)} V${sy(21)} Q${sx(25)} ${sy(27)} ${sx(19)} ${sy(27)} H${sx(-19)} Q${sx(-25)} ${sy(27)} ${sx(-25)} ${sy(21)} Z" fill="${accent}" opacity="0.14" stroke="${color}" stroke-width="${2.4 * s}"/>` +
        `<path d="M${sx(-14)} ${sy(-14)} H${sx(14)} M${sx(-7)} ${sy(-24)} H${sx(7)}" ${common} stroke-width="${2.6 * s}" opacity="0.82"/>` +
        `<circle cx="${sx(-10)}" cy="${sy(13)}" r="${2.8 * s}" fill="${color}" opacity="0.55"/><circle cx="${x}" cy="${sy(13)}" r="${2.8 * s}" fill="${color}" opacity="0.38"/><circle cx="${sx(10)}" cy="${sy(13)}" r="${2.8 * s}" fill="${color}" opacity="0.24"/>`;
  }
}

function statusCard({ icon, label, subtitle = '', detail = '', tone = 'info' }) {
  const c = TONES[tone] || TONES.info;
  const lbl = fit(label, 116, 16);
  const sub = fit(subtitle, 116, 11);
  const det = fit(detail, 120, 9);
  const inner = [
    `<rect x="25" y="18" width="94" height="58" rx="14" fill="${c.panel}" opacity="0.68" stroke="${c.accent}" stroke-width="1.2" stroke-opacity="0.28"/>`,
    glyph(icon, c.icon, c.accent, 72, 47, 0.94),
    `<text x="72" y="${sub ? 98 : 106}" text-anchor="middle" font-family="${esc(FONT_UI)}" font-size="${lbl.length > 11 ? 14 : 16}" font-weight="800" fill="${c.text}">${esc(lbl)}</text>`,
    sub ? `<text x="72" y="115" text-anchor="middle" font-family="${esc(FONT_UI)}" font-size="11" font-weight="650" fill="${c.sub}" opacity="0.86">${esc(sub)}</text>` : '',
    det ? `<text x="72" y="128" text-anchor="middle" font-family="${esc(FONT_UI)}" font-size="9" font-weight="600" fill="${c.sub}" opacity="0.6">${esc(det)}</text>` : '',
  ].join('');
  return toDataUrl(svgFrame(c.bg, inner));
}

// ── RUNNING 테두리 회전 (AgentDeck renderOrbitingRect) ──
// 둥근 사각형(128, rx 12)의 실제 둘레. 마지막 프레임과 첫 프레임이 끊김 없이 이어지도록 이 값으로 나눈다.
const ORBIT_PERIMETER = 4 * (128 - 24) + 2 * Math.PI * 12;
export const ORBIT_FRAMES = 24;
export const ORBIT_DELAY_MS = 145; // 한 바퀴 ≈ 3.5초 (AgentDeck과 같은 속도)

function orbitBorder(frame) {
  const t = frame / ORBIT_FRAMES;
  const pulse = 0.72 + 0.2 * Math.abs(Math.sin(Math.PI * t));
  const dash = 92;
  const off = (-t * ORBIT_PERIMETER).toFixed(2);
  const common = `x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${WORKING}" stroke-linecap="round"`;
  const dashAttr = `stroke-dasharray="${dash} ${(ORBIT_PERIMETER - dash).toFixed(2)}" stroke-dashoffset="${off}"`;
  return `<rect ${common} stroke-width="1.2" opacity="0.18"/>` +
    `<rect ${common} stroke-width="4.8" ${dashAttr} opacity="${(pulse * 0.72).toFixed(2)}" filter="url(#pg)"/>` +
    `<rect ${common} stroke-width="2.2" ${dashAttr} opacity="${Math.min(1, pulse + 0.06).toFixed(2)}"/>`;
}

// ── 세션 키 (AgentDeck renderSessionSlot) ──

/**
 * 위의 작은 라벨(y 32) 아래 상자(top..bottom)에, 잘리지 않고 들어가는 가장 큰 크기로 여러 줄 글을 놓는다.
 * 다 안 들어가면 가장 작은 크기에서 마지막 줄을 …로 자른다. 세로는 상자 가운데.
 * 실기기에서 5줄(14px)은 안 읽혀서 최대 4줄, 가장 작은 글자 16px.
 */
function fitBlock(text, { x = 20, w = 100, top = 40, bottom = 122, sizes = [22, 20, 18, 16], maxLines: cap = 4, weight = 600, fill = UI.hudText } = {}) {
  let size, lh, lines;
  for (size of sizes) {
    lh = Math.round(size * 1.15);
    const maxLines = Math.min(cap, Math.floor((bottom - top - size) / lh) + 1);
    lines = wrapByWidth(text, w, size, 99);
    if (lines.length <= maxLines) break;
    lines = wrapByWidth(text, w, size, maxLines);
  }
  const firstY = top + (bottom - top - ((lines.length - 1) * lh + size)) / 2 + size * 0.82; // 0.82 ≈ 글자 윗부분(ascent)
  return lines.map((l, i) =>
    `<text x="${x}" y="${(firstY + i * lh).toFixed(1)}" font-size="${size}" font-weight="${weight}" fill="${fill}" font-family="${esc(FONT_UI)}">${esc(l)}</text>`).join('');
}
/**
 * @param {object} v
 * @param {'working'|'awaiting'|'idle'|'ended'} v.tone
 * @param {string} v.agent   에이전트 id (claude, codex …) — 강조색
 * @param {string} v.name    세션 이름
 */
export const renderSession = (v) => toDataUrl(sessionSvg(v));

/** 움직이는 키(RUNNING·PERMIT?·DONE)인지 */
export const isAnimated = (v) => v.tone === 'working' || v.tone === 'awaiting' || (v.tone === 'idle' && v.fresh);

/** 움직이는 키의 GIF 프레임(SVG 문자열 ORBIT_FRAMES개) */
export const sessionFrames = (v) => Array.from({ length: ORBIT_FRAMES }, (_, i) => sessionSvg(v, i));

function sessionSvg(v, frame = null) {
  const isWorking = v.tone === 'working';
  const isAsking = v.tone === 'awaiting';
  const isEnded = v.tone === 'ended';
  const isDone = v.tone === 'idle' && !!v.fresh; // 방금 끝남 — 확인할 때까지 초록으로 깜빡인다
  const accent = agentAccent(v.agent);
  const fam = esc(FONT_UI);

  const stateLbl = isAsking ? (v.ask ? 'CHOOSE?' : 'PERMIT?') : isWorking ? 'RUNNING' : isEnded ? 'ENDED' : isDone ? 'DONE' : 'IDLE';
  const colorText = isWorking ? '#CCFBF1' : isAsking ? '#FCD34D' : isDone ? '#BBF7D0' : isEnded ? UI.idleDark : accent;

  const nameText = fitBlock(v.name || '(untitled)', { fill: isEnded ? '#71717A' : UI.hudText });

  const blur = `<filter id="pg" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur in="SourceGraphic" stdDeviation="2.4"/></filter>`;
  let defs = `<linearGradient id="sd-bg" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#1C1C1E"/><stop offset="100%" stop-color="#0C0C0E"/></linearGradient>`;
  let border = '';
  let pill = '';
  if (isWorking) {
    defs += blur;
    border = frame != null ? orbitBorder(frame) :
      `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${WORKING}" stroke-width="4.5" opacity="0.9" filter="url(#pg)"/>` +
      `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${WORKING}" stroke-width="1.5" opacity="0.81"/>`;
  } else if (isAsking) {
    // 깜빡임: 한 바퀴(ORBIT_FRAMES)에 두 번. 정적일 때는 가장 밝은 모습.
    const b = frame != null ? Math.abs(Math.cos((2 * Math.PI * frame) / ORBIT_FRAMES)) : 1;
    defs += blur;
    border = `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${UI.attn}" stroke-width="7" opacity="${(0.6 * b).toFixed(2)}" filter="url(#pg)"/>` +
      `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${UI.attn}" stroke-width="3" opacity="${(0.3 + 0.67 * b).toFixed(2)}"/>`;
    if (!v.ask) pill = `<rect x="94" y="14" width="38" height="17" rx="8.5" fill="${UI.attn}"/><text x="113" y="26.5" font-size="10" font-weight="800" text-anchor="middle" fill="#221500" font-family="${fam}">PERM</text>`;
  } else if (isDone) {
    // 한 바퀴에 한 번, 천천히
    const b = frame != null ? Math.abs(Math.cos((Math.PI * frame) / ORBIT_FRAMES)) : 1;
    defs += blur;
    border = `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${UI.ok}" stroke-width="6" opacity="${(0.55 * b).toFixed(2)}" filter="url(#pg)"/>` +
      `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${UI.ok}" stroke-width="2.5" opacity="${(0.25 + 0.7 * b).toFixed(2)}"/>`;
  }


  return (svgOpen +
    `<defs>${defs}</defs>` +
    `<rect width="${SIZE}" height="${SIZE}" rx="16" fill="url(#sd-bg)"/>` +
    `<rect x="8" y="8" width="128" height="128" rx="12" fill="#2C2C2E" opacity="0.8"/>` +
    border + pill +
    // PERM 알약과 겹치지 않도록 승인 대기일 때만 글자를 조금 줄인다
    `<text x="20" y="32" font-size="${pill ? 14 : 17}" font-weight="800" fill="${colorText}" font-family="${fam}">${stateLbl}</text>` +
    nameText + `</svg>`);
}

export const renderEmpty = () => toDataUrl(svgFrame('#0a0a0a', ''));

export function renderMoreKey({ hidden, page, pages, total }) {
  if (pages > 1) return statusCard({ icon: 'more', label: 'MORE', subtitle: `+${hidden} · ${page + 1}/${pages}`, tone: 'info' });
  return statusCard({ icon: 'more', label: 'MORE', subtitle: total ? `${total} SHOWN` : 'NO SESSIONS', tone: 'muted' });
}

// 더보기 키를 따로 두지 않았을 때 마지막 슬롯이 대신 쓰는 모양
export const renderMore = (hidden) => statusCard({ icon: 'more', label: 'MORE', subtitle: `+${hidden}`, tone: 'info' });

export const renderNoSessions = () => statusCard({ icon: 'no-session', label: 'NO SESSIONS', subtitle: 'Orca', tone: 'muted' });

export const renderError = (title, detail) => statusCard({ icon: 'offline', label: 'OFFLINE', subtitle: title, detail, tone: 'brand' });

// ── 남은 한도 (AgentDeck renderUsageGauge / renderUsagePairGauge) ──
// 기본은 남은 %(LEFT)와 남은 양만큼의 물높이. 키를 누르면 사용한 %(USED)로 바뀐다(d.showUsed).
// 숫자·물높이·막대만 바뀌고, 색은 항상 사용량 기준이다.
// 색은 AgentDeck과 같은 기준: 사용 70% 미만 초록, 90% 미만 주황, 그 이상 빨강.

function usageColor(used, muted) {
  if (muted || used == null || !Number.isFinite(used)) return UI.idleDark;
  if (used >= 90) return UI.error;
  if (used >= 70) return UI.attn;
  return UI.ok;
}

export function formatResetCountdown(resetsAt, now = Date.now()) {
  if (!resetsAt) return '';
  const diff = resetsAt - now;
  if (diff <= 0) return 'now';
  const totalH = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (totalH >= 24) {
    const d = Math.floor(totalH / 24);
    const h = totalH % 24;
    return h > 0 ? `${d}d${h}h` : `${d}d`;
  }
  return totalH > 0 ? `${totalH}h${m}m` : `${m}m`;
}

function agoShort(ms) {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

function brandTag(provider, x, y, size, dim) {
  const name = provider === 'codex' ? 'Codex' : provider === 'fable' ? 'Fable' : 'Claude';
  const color = dim ? '#64748b' : agentAccent(provider === 'fable' ? 'claude' : provider);
  return `<text x="${x}" y="${y}" text-anchor="end" font-family="${esc(FONT_UI)}" font-size="${size}" font-weight="700" fill="${color}">${name}</text>`;
}

/**
 * @param {object} d
 * @param {'claude'|'codex'|'fable'} d.provider
 * @param {string} d.label           '5H' | '7D'
 * @param {{usedPercent:number,resetsAt:number|null}|null} d.window
 * @param {string|null} d.error
 * @param {number} d.updatedAt
 * @param {boolean} [d.showUsed]  true면 사용한 %를 보여준다
 */
export function renderUsageGauge(d) {
  const W = 144, H = 144, RX = 12;
  const now = Date.now();
  const clip = `<defs><clipPath id="ug"><rect width="${W}" height="${H}" rx="${RX}"/></clipPath></defs>`;
  const bg = `<rect width="${W}" height="${H}" rx="${RX}" fill="#0f172a"/>`;
  const labelEl = (color) => `<text x="14" y="36" font-family="${esc(FONT_MONO)}" font-size="26" font-weight="bold" fill="${color}">${esc(d.label)}</text>`;

  if (!d.window) {
    const note = d.error ? wrapByWidth(d.error, 120, 10, 2) : [d.loading ? 'loading…' : ''];
    return toDataUrl(svgOpen + clip + bg + labelEl('#64748b') + brandTag(d.provider, 130, 32, 13, true) +
      `<text x="72" y="92" text-anchor="middle" font-family="${esc(FONT_NUM)}" font-size="44" font-weight="bold" fill="#475569">—</text>` +
      note.map((l, i) => `<text x="72" y="${114 + i * 13}" text-anchor="middle" font-family="${esc(FONT_UI)}" font-size="10" fill="#64748b">${esc(l)}</text>`).join('') +
      `</svg>`);
  }

  const used = Math.max(0, Math.min(100, d.window.usedPercent));
  const shown = d.showUsed ? Math.round(used) : Math.round(100 - used);
  const stale = !!(d.error && d.updatedAt && now - d.updatedAt > 60000);
  const color = usageColor(used, stale);
  const fillH = Math.round((H * shown) / 100);
  const fillY = H - fillH;
  const fill = fillH > 0
    ? `<g clip-path="url(#ug)"><rect x="0" y="${fillY}" width="${W}" height="${fillH}" fill="${color}" opacity="${stale ? 0.22 : 0.38}"/><rect x="0" y="${fillY}" width="${W}" height="3" fill="${color}"/></g>`
    : '';
  const reset = stale ? agoShort(now - d.updatedAt) : formatResetCountdown(d.window.resetsAt, now);
  const head = stale ? '#64748b' : '#ffffff';

  return toDataUrl(svgOpen + clip + bg + fill + labelEl(head) + brandTag(d.provider, 130, 32, 13, stale) +
    pctLabel(shown, d.showUsed ? 'USED' : 'LEFT', 92, 42, head) +
    (reset ? `<text x="72" y="122" text-anchor="middle" font-family="${esc(FONT_NUM)}" font-size="17" font-weight="bold" fill="${head}">${esc(reset)}</text>` : '') +
    `</svg>`);
}

// "73%LEFT" / "27%USED" — 숫자는 크게, 단위는 작게. tspan 없이 두 덩어리로 가운데 맞춤 (AgentDeck remainingPercentSvgText)
function pctLabel(value, word, y, size, fill) {
  const num = `${value}%`;
  const unit = Math.round(size * 0.32);
  const gap = 3;
  const total = textW(num, size) + gap + textW(word, unit);
  const x0 = 72 - total / 2;
  const x1 = x0 + textW(num, size) + gap;
  return `<text x="${x0.toFixed(1)}" y="${y}" font-family="${esc(FONT_NUM)}" font-size="${size}" font-weight="bold" fill="${fill}">${num}</text>` +
    `<text x="${x1.toFixed(1)}" y="${y}" font-family="${esc(FONT_NUM)}" font-size="${unit}" font-weight="bold" fill="${fill}" opacity="0.8">${word}</text>`;
}

/** 한 키에 두 창(5H + 7D)을 위아래로 (AgentDeck renderUsagePairGauge). showUsed면 사용한 %. */
export function renderUsagePairGauge(provider, rows, showUsed = false) {
  const W = 144, H = 144, RX = 12;
  const now = Date.now();
  const bg = `<rect width="${W}" height="${H}" rx="${RX}" fill="${UI.popupBgMid}"/>`;
  const divider = `<rect x="8" y="${H / 2 - 1}" width="128" height="1" fill="${UI.ttyFaint}"/>`;
  const body = rows.map((r, i) => {
    const y = i * (H / 2);
    if (!r.window) {
      return `<text x="12" y="${y + 29}" font-family="${esc(FONT_MONO)}" font-size="18" font-weight="bold" fill="${UI.ttyDim}">${esc(r.label)}</text>` +
        `<text x="130" y="${y + 29}" text-anchor="end" font-family="${esc(FONT_PLEX)}" font-size="20" font-weight="bold" fill="${UI.ttyDim}">—</text>` +
        (r.error ? `<text x="12" y="${y + 51}" font-family="${esc(FONT_UI)}" font-size="10" fill="${UI.ttyDim}">${esc(fit(r.error, 120, 10))}</text>` : '');
    }
    const used = Math.max(0, Math.min(100, r.window.usedPercent));
    const shown = showUsed ? Math.round(used) : Math.round(100 - used);
    const stale = !!(r.error && r.updatedAt && now - r.updatedAt > 60000);
    const color = usageColor(used, stale);
    const text = stale ? UI.ttyDim : TIDE_50;
    const reset = stale ? agoShort(now - r.updatedAt) : formatResetCountdown(r.window.resetsAt, now);
    const barW = Math.round((120 * shown) / 100);
    const numRight = 118;
    return `<text x="12" y="${y + 29}" font-family="${esc(FONT_MONO)}" font-size="18" font-weight="bold" fill="${text}">${esc(r.label)}</text>` +
      `<text x="${numRight}" y="${y + 29}" text-anchor="end" font-family="${esc(FONT_PLEX)}" font-size="20" font-weight="bold" fill="${text}">${shown}</text>` +
      `<text x="${numRight + 2}" y="${y + 29}" font-family="${esc(FONT_PLEX)}" font-size="12" font-weight="bold" fill="${text}">%</text>` +
      (reset ? `<text x="12" y="${y + 51}" font-family="${esc(FONT_MONO)}" font-size="11" font-weight="bold" fill="${text}">${esc(reset)}</text>` : '') +
      `<rect x="12" y="${y + 62}" width="120" height="3" rx="1.5" fill="${UI.ttyFaint}"/>` +
      (barW > 0 ? `<rect x="12" y="${y + 62}" width="${barW}" height="3" rx="1.5" fill="${color}" opacity="${stale ? 0.55 : 1}"/>` : '');
  }).join('');
  // 브랜드 이름은 위 칸, LEFT/USED는 아래 칸 초기화 시간 줄의 오른쪽 끝에
  const mode = `<text x="132" y="${H / 2 + 51}" text-anchor="end" font-family="${esc(FONT_MONO)}" font-size="11" font-weight="bold" fill="${UI.hudSubtext}">${showUsed ? 'USED' : 'LEFT'}</text>`;
  return toDataUrl(svgOpen + bg + divider + body + brandTag(provider, 132, 51, 11, false) + mode + `</svg>`);
}

// ── 세션 상세 화면 (세션 키를 길게 누르면) ──
// 구성은 AgentDeck의 detail 화면(BACK · 세션 · 선택지 · STOP/ESC)을 따르고, 글자 정보 카드는 키가 작아 넣지 않는다.

const BTN = {
  muted: { fg: '#E2E8F0', sub: '#94A3B8' },
  attn: { fg: UI.attn, sub: '#FCD34D' },
  danger: { fg: UI.error, sub: '#FCA5A5' },
};

/** 큰 기호 + 아래 짧은 이름 (BACK, OPEN, STOP, ESC) */
export function renderButton({ big, label, tone = 'muted' }) {
  const c = BTN[tone] || BTN.muted;
  const bigSize = textW(big, 44) > 100 ? 30 : 44;
  return toDataUrl(svgFrame('#0a0a0c',
    `<text x="72" y="80" text-anchor="middle" font-family="${esc(FONT_UI)}" font-size="${bigSize}" font-weight="800" fill="${c.fg}">${esc(big)}</text>` +
    `<text x="72" y="116" text-anchor="middle" font-family="${esc(FONT_UI)}" font-size="14" font-weight="800" fill="${c.sub}">${esc(fit(label, 116, 14))}</text>`));
}

/** 승인·질문 선택지: 왼쪽 위 작은 번호 + 선택지 문구(들어가는 가장 큰 크기) */
export function renderOption(n, label) {
  return toDataUrl(svgFrame('#1a1206',
    `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${UI.attn}" stroke-width="2" opacity="0.7"/>` +
    `<text x="20" y="32" font-family="${esc(FONT_UI)}" font-size="17" font-weight="800" fill="${UI.attn}">${esc(n)}</text>` +
    fitBlock(label, { w: 104 })));
}

/** 빠른 답장: 위에 작은 REPLY, 아래 보낼 문구 */
export function renderReply(text) {
  const lines = wrapByWidth(text, 108, 16, 3);
  return toDataUrl(svgFrame('#0a0a0c',
    `<text x="18" y="32" font-family="${esc(FONT_UI)}" font-size="11" font-weight="800" fill="${UI.hudSubtext}">REPLY</text>` +
    lines.map((l, i) => `<text x="18" y="${64 + i * 20}" font-family="${esc(FONT_UI)}" font-size="16" font-weight="700" fill="${UI.hudText}">${esc(l)}</text>`).join('')));
}
