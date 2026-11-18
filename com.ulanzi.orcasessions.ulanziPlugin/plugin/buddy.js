// 버디 키: Claude 캐릭터(Clawd)가 전체 세션 상황에 따라 움직인다.
//
// 모양은 Claude Code 시작 화면의 블록 문자 그림을 픽셀로 옮긴 것:
//    ▐▛███▜▌
//   ▝▜█████▛▘
//     ▘▘ ▝▝
// 블록 문자 한 칸 = 2×2 픽셀이고 터미널 칸은 세로로 길어서, 정사각 픽셀로 바꾸면 18×10 격자가 된다.

const COLS = 18;
const U = 6; // 픽셀 하나의 크기 (18×6 = 108px)
const X0 = (144 - COLS * U) / 2;
const Y0 = 46; // 몸 맨 위. 위쪽은 효과(!, z, 색종이), 아래는 이름
export const BUDDY_FRAMES = 8;
export const BUDDY_DELAY_MS = 180;

const ORANGE = '#D77757';
const GRAY = '#7a8a9c';
const COLOR = { needs: '#FFA93D', working: '#2DD4BF', done: '#52D988', idle: '#94A3B8', offline: '#7a8a9c', react: '#F5F3EC' };
const PINK = '#F472B6';

/** 쉬는 중에 누르면 나오는 반응들 (이름 → 키 아래 글자) */
export const REACTIONS = { wave: 'HI!', love: 'LOVE', dance: 'DANCE', jump: 'BOING', yawn: 'YAWN', wink: 'WINK', surprise: '?!' };

// [열, 행] 목록
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const block = (cols, rows) => cols.flatMap((c) => rows.map((r) => [c, r]));
const EYES = [[5, 2], [5, 3], [12, 2], [12, 3]];
const isEye = ([c, r]) => EYES.some(([ec, er]) => ec === c && er === r);
const BODY = block(range(3, 14), range(0, 7)).filter((p) => !isEye(p));
// 올린 팔은 손끝이 한 칸 더 위로 (귀처럼 안 보이게)
const ARM = {
  left: { down: block([1, 2], [4, 5]), up: [...block([1, 2], [2, 3]), [1, 1]] },
  right: { down: block([15, 16], [4, 5]), up: [...block([15, 16], [2, 3]), [16, 1]] },
};
const LEGS = block([4, 6, 11, 13], [8, 9]);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pixels(list, color, dy = 0, dx = 0) {
  return list.map(([c, r]) => `<rect x="${X0 + (c + dx) * U}" y="${Y0 + (r + dy) * U}" width="${U}" height="${U}" fill="${color}"/>`).join('');
}

/** Clawd 한 장. dy/dx: 이동(픽셀), arms: ['up'|'down', 'up'|'down'], eyes: 'open'|'closed'|'wink' */
function clawd({ dy = 0, dx = 0, arms = ['down', 'down'], eyes = 'open', color = ORANGE, legs = true }) {
  const shut = eyes === 'closed' ? [[5, 3], [12, 3]] : eyes === 'wink' ? [[12, 3]] : []; // 아래 절반만 메워 감은 눈
  return pixels(BODY, color, dy, dx) + pixels(shut, color, dy, dx) +
    pixels(ARM.left[arms[0]], color, dy, dx) + pixels(ARM.right[arms[1]], color, dy, dx) +
    (legs ? pixels(LEGS, color, dy, dx) : '');
}

// 5×4 픽셀 하트
const HEART = [[1, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [1, 2], [2, 2], [3, 2], [2, 3]];
const heart = (c, r, color, k = 0.5) => HEART.map(([hc, hr]) => dot(c + hc * k, r + hr * k, color, U * k)).join('');
const glyph = (c, r, ch, color, size = 16, opacity = 1) =>
  `<text x="${X0 + c * U}" y="${Y0 + r * U}" font-family="Arial" font-weight="bold" font-size="${size}" fill="${color}" opacity="${opacity}">${esc(ch)}</text>`;

/** 쉬는 중에 눌렀을 때의 반응 한 장면 */
function reaction(kind, f) {
  const t = f / BUDDY_FRAMES;
  switch (kind) {
    case 'wave': // 오른팔을 흔든다
      return clawd({ arms: ['down', f % 2 ? 'up' : 'down'] });
    case 'love': // 눈 감고 웃으며 하트가 떠오른다
      return clawd({ dy: f % 4 < 2 ? 0 : -0.5, eyes: 'closed' }) +
        heart(0.5, -2 - t * 4, PINK) + heart(13.5, -4 - t * 4, PINK, 0.6) + heart(7, -6 - t * 3, '#FB7185', 0.4);
    case 'dance': // 좌우로 흔들며 음표
      return clawd({ dx: [-1, 0, 1, 0, -1, 0, 1, 0][f], arms: f % 2 ? ['up', 'down'] : ['down', 'up'] }) +
        glyph(-1 + (f % 4), -2 - (f % 3), '♪', COLOR.working, 16) + glyph(14 - (f % 3), -4 - (f % 2), '♪', PINK, 14);
    case 'jump': // 높이 점프
      return clawd({ dy: [0, -3, -5, -6, -5, -3, 0, 0][f], arms: f > 0 && f < 6 ? ['up', 'up'] : ['down', 'down'] });
    case 'yawn': // 기지개: 팔을 천천히 올렸다 내림
      return clawd({ dy: f >= 2 && f <= 5 ? -0.5 : 0, eyes: 'closed', arms: f >= 2 && f <= 5 ? ['up', 'up'] : ['down', 'down'] }) +
        (f >= 2 && f <= 5 ? glyph(15.5, -1, '~', COLOR.idle, 16) : '');
    case 'wink': // 한쪽 눈 감고 반짝
      return clawd({ eyes: f >= 2 && f <= 5 ? 'wink' : 'open' }) +
        (f >= 2 && f <= 5 ? dot(15, -1, '#FDE047', U * 0.5) + dot(14.5, -0.5, '#FDE047', U * 0.5) + dot(15.5, -0.5, '#FDE047', U * 0.5) + dot(15, 0, '#FDE047', U * 0.5) : '');
    case 'surprise': // 깜짝: 펄쩍 + ?!
    default:
      return clawd({ dy: [0, -2, -2, -1, 0, 0, 0, 0][f], arms: f >= 1 && f <= 3 ? ['up', 'up'] : ['down', 'down'] }) +
        (f >= 1 ? glyph(7, -2.5, '?!', '#F5F3EC', 18) : '');
  }
}

const frameSvg = (inner, label, labelColor) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
  // 항상 GIF로 나가므로 그라데이션 대신 단색 (GIF 색 수 제한으로 띠가 생긴다)
  `<rect width="144" height="144" rx="16" fill="#141416"/>` + inner +
  `<text x="72" y="130" text-anchor="middle" font-family="Inter, -apple-system, 'Apple SD Gothic Neo', sans-serif" font-size="13" font-weight="800" fill="${labelColor}">${esc(label)}</text></svg>`;

// 효과용 작은 사각형 (격자 밖에도 그릴 수 있게 픽셀 좌표로)
const dot = (c, r, color, size = U) => `<rect x="${X0 + c * U}" y="${Y0 + r * U}" width="${size}" height="${size}" fill="${color}"/>`;

function scene(mood, f, sweat, kind) {
  const t = f / BUDDY_FRAMES;
  let body = '';
  let fx = '';
  if (mood === 'react') {
    body = reaction(kind, f);
  } else if (mood === 'needs') {
    // 깡충깡충 + 양팔 흔들기 + 머리 위 ! 깜빡임
    const dy = [0, -1, -2, -3, -2, -1, 0, 0][f];
    body = clawd({ dy, arms: f % 2 ? ['up', 'down'] : ['down', 'up'] });
    if (f % 4 < 3) fx = pixels([[8, -6], [9, -6], [8, -5], [9, -5], [8, -4], [9, -4], [8, -2], [9, -2]], COLOR.needs, dy);
  } else if (mood === 'working') {
    // 타자: 팔을 번갈아 올리고 몸을 살짝 들썩, 머리 위 점 세 개가 하나씩
    body = clawd({ dy: f % 2 ? 0 : -0.5, arms: f % 2 ? ['up', 'down'] : ['down', 'up'] });
    const n = Math.floor(f / 2) % 4;
    for (let i = 0; i < n; i++) fx += dot(6 + i * 2.5, -3, COLOR.working);
  } else if (mood === 'done') {
    // 만세 + 점프 + 색종이
    const dy = [0, -2, -3, -2, 0, -2, -3, -2][f];
    body = clawd({ dy, arms: ['up', 'up'] });
    const conf = [[1, -5, '#52D988'], [5, -7, '#FFA93D'], [10, -6, '#2DD4BF'], [15, -7, '#F472B6'], [13, -4, '#52D988'], [3, -3, '#2DD4BF']];
    for (const [c, r, col] of conf) fx += dot(c, r + ((f * 0.75) % 5), col, U * 0.7);
  } else {
    // 졸기: 눈 감고 천천히 숨쉬기, z가 오른쪽 위로 떠오름 (Orca 꺼짐이면 회색)
    const off = mood === 'offline';
    body = clawd({ dy: f < 4 ? 0 : 0.5, eyes: 'closed', color: off ? GRAY : ORANGE });
    const zc = off ? '#64748b' : COLOR.idle;
    const zs = [[15.5, -1 - t * 3, 11], [17, -4 - t * 3, 14]];
    fx = zs.map(([c, r, size]) => `<text x="${X0 + c * U}" y="${Y0 + r * U}" font-family="Arial" font-weight="bold" font-size="${size}" fill="${zc}" opacity="${(1 - t * 0.6).toFixed(2)}">z</text>`).join('');
  }
  // 한도가 바닥나 가면 머리 옆에 땀방울
  if (sweat && mood !== 'offline') fx += dot(16.5, -1 + (f % 4) * 0.8, '#60A5FA', U * 0.8) + dot(16.3, -1.8 + (f % 4) * 0.8, '#60A5FA', U * 0.5);
  return body + fx;
}

/**
 * @param {{mood:'needs'|'working'|'done'|'idle'|'offline'|'react', label:string, sweat?:boolean, kind?:string}} s
 *   react면 kind는 REACTIONS의 키
 * @returns {string[]} 프레임별 SVG (첫 장이 정적 그림)
 */
export function buddyFrames(s) {
  return Array.from({ length: BUDDY_FRAMES }, (_, f) => frameSvg(scene(s.mood, f, s.sweat, s.kind), s.label, s.kind === 'love' ? PINK : COLOR[s.mood]));
}
