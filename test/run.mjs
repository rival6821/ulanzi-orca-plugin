// 시나리오 테스트: 가짜 Ulanzi Studio(웹소켓 호스트) + 가짜 orca + 가짜 사용량 API로
// 메인 서비스를 실제로 띄우고, 키에 그려진 SVG 내용을 확인한다.
//
//   npm test              시나리오 실행
//   npm run preview       실행 후 test/out/preview.html 생성 (브라우저로 열어 키 모양 확인)

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'com.ulanzi.orcasessions.ulanziPlugin');
const require = createRequire(path.join(PLUGIN, 'package.json'));
let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch {
  console.error('ws가 없습니다. 먼저 `npm run setup`을 실행하세요.');
  process.exit(1);
}

const PREVIEW = process.argv.includes('--preview');
const P = 'com.ulanzi.ulanzistudio.orcasessions';
const PORT = 39000 + Math.floor(Math.random() * 900);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-ulanzi-'));
const STATE = path.join(TMP, 'state.json');
const LOG = path.join(TMP, 'calls.log');
const FAKE_HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(FAKE_HOME, '.claude'), { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.codex'), { recursive: true });
fs.writeFileSync(path.join(FAKE_HOME, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } }));
fs.writeFileSync(path.join(FAKE_HOME, '.codex/auth.json'), JSON.stringify({ tokens: { access_token: 'fake', account_id: 'acc' } }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setState = (s) => fs.writeFileSync(STATE, JSON.stringify(s));

// D200H: 5열 x 3행, 키 이름은 "열_행". 아랫줄 오른쪽 두 칸은 기본 시계 위젯 자리.
const LAYOUT = [];
for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) LAYOUT.push({ key: `${c}_${r}`, action: r === 1 && c === 4 ? 'more' : 'slot' });
for (let c = 0; c < 3; c++) LAYOUT.push({ key: `${c}_2`, action: 'usage' });

const icons = {};
const gifs = {};
let sock;
const wss = new WebSocketServer({ port: PORT });
wss.on('connection', (ws) => {
  sock = ws;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    // 정적 그림(type 2)은 icons, 움직이는 GIF(type 3)는 gifs. GIF가 온 뒤에도 icons엔 같은 장면의 SVG가 남는다.
    if (m.cmd === 'state') for (const s of m.param.statelist) {
      if (s.type === 3) gifs[s.key] = s.gifdata;
      else { icons[s.key] = s.data; delete gifs[s.key]; }
    }
  });
});
const send = (o) => sock.send(JSON.stringify(o));
const svgOf = (key) => (icons[key] ? Buffer.from(icons[key].split(',')[1], 'base64').toString('utf8') : '');

// ── 시나리오 데이터 ──
const titles = ['로그인 버그 고치기', 'Refactor payment module', 'README 업데이트', 'API 테스트 작성', '다크 모드 추가', 'CI 캐시 정리', '검색 성능 개선', '알림 설정 화면', 'i18n 키 정리', '온보딩 문구 수정', '로그 포맷 통일'];
const states = ['working', 'blocked', 'done', 'working', 'done', 'waiting', 'blocked', 'done', 'working', 'done', 'done'];
const terminals = titles.map((t, i) => ({
  handle: 'h' + i, tabId: 'tab' + i, leafId: 'leaf' + i, worktreePath: '/Users/me/dev/app-' + i,
  branch: 'feat/task-' + i, title: '✳ ' + t, connected: true, writable: true,
  lastOutputAt: Date.now() - 60000, preview: '', agentIdentity: i % 3 === 1 ? 'codex' : 'claude',
}));
terminals.push({ handle: 'shell', tabId: 'ts', leafId: 'ls', worktreePath: '/x', branch: 'main', title: 'zsh', connected: true, lastOutputAt: Date.now() });
const agents = titles.map((t, i) => ({
  paneKey: `tab${i}:leaf${i}`, state: states[i], agentType: i % 3 === 1 ? 'codex' : 'claude', conversationName: t,
  toolName: states[i] === 'working' ? 'Bash' : states[i] === 'blocked' ? 'Bash: npm test' : null,
  // 4번(다크 모드)만 방금 끝남 → DONE으로 깜빡임. 나머지 done은 1시간 전.
  stateStartedAt: Date.now() - (i === 4 ? 0 : 3600000),
}));

const results = [];
const check = (name, cond) => results.push({ name, ok: !!cond });
const snapshots = [];
const gifUrls = () => Object.fromEntries(Object.entries(gifs).map(([k, g]) => [k, 'data:image/gif;base64,' + g]));
const snap = (title) => snapshots.push({ title, icons: { ...icons, ...gifUrls() } });

setState({ terminals, agents });
const child = spawn(process.execPath, ['--import', path.join(ROOT, 'test/fixtures/mock-fetch.mjs'), path.join(PLUGIN, 'plugin/app.js'), '127.0.0.1', String(PORT), 'ko_KR'], {
  env: {
    ...process.env, HOME: FAKE_HOME, ORCA_SESSIONS_TEST: '1',
    ORCA_SESSIONS_ORCA_BIN: path.join(ROOT, 'test/fixtures/fake-orca.cjs'),
    ORCA_FAKE_STATE: STATE, ORCA_FAKE_LOG: LOG,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));

try {
  await sleep(800);
  if (!sock) throw new Error('플러그인이 호스트에 연결하지 않았습니다');
  for (const l of LAYOUT) send({ cmd: 'add', uuid: `${P}.${l.action}`, key: l.key, actionid: 'a' + l.key, param: {} });
  await sleep(2800);
  snap('세션 11개 + 셸 1개 (에이전트만 표시)');

  check('0_0 작업 중 세션은 RUNNING', svgOf('0_0').includes('RUNNING'));
  check('1_0 blocked 세션은 PERMIT? + PERM', svgOf('1_0').includes('PERMIT?') && svgOf('1_0').includes('>PERM<'));
  check('2_0 done 세션은 IDLE', svgOf('2_0').includes('>IDLE<'));
  check('waiting 상태도 RUNNING으로 표시 (0_1)', svgOf('0_1').includes('RUNNING'));
  check('RUNNING 키는 움직이는 GIF로 바뀜', Buffer.from(gifs['0_0'] || '', 'base64').subarray(0, 6).toString() === 'GIF89a');
  const isGif = (k) => Buffer.from(gifs[k] || '', 'base64').subarray(0, 6).toString() === 'GIF89a';
  check('PERMIT? 키도 깜빡이는 GIF', isGif('1_0'));
  check('방금 끝난 세션은 DONE + GIF (4_0)', svgOf('4_0').includes('>DONE<') && isGif('4_0'));
  check('오래전에 끝난 세션은 IDLE, GIF 없음 (2_0)', !gifs['2_0']);

  send({ cmd: 'run', uuid: `${P}.slot`, key: '4_0', actionid: 'a4_0' });
  await sleep(400);
  check('DONE 키를 누르면 깜빡임이 멈추고 IDLE', svgOf('4_0').includes('>IDLE<') && !gifs['4_0']);
  check('셸 터미널은 숨김', !Object.keys(icons).some((k) => svgOf(k).includes('>zsh<')));
  check('더보기 키에 +2 · 1/2', svgOf('4_1').includes('+2 · 1/2'));
  check('한도 0_2 = Claude 5H 73% 남음', svgOf('0_2').includes('>5H<') && svgOf('0_2').includes('>73%<'));
  check('한도 1_2 = Claude 7D 36% 남음', svgOf('1_2').includes('>7D<') && svgOf('1_2').includes('>36%<'));
  check('한도 2_2 = Codex 5H+7D 묶음', svgOf('2_2').includes('Codex') && svgOf('2_2').includes('>12<') && svgOf('2_2').includes('>0<'));

  send({ cmd: 'run', uuid: `${P}.usage`, key: '0_2', actionid: 'a0_2' });
  await sleep(300);
  snap('한도 키를 누른 뒤 (사용한 %)');
  check('한도 키를 누르면 모든 한도 키가 사용한 %로', svgOf('0_2').includes('>27%<') && svgOf('0_2').includes('>USED<') &&
    svgOf('1_2').includes('>64%<') && svgOf('2_2').includes('>88<') && svgOf('2_2').includes('>USED<'));
  send({ cmd: 'run', uuid: `${P}.usage`, key: '2_2', actionid: 'a2_2' });
  await sleep(300);
  check('한 번 더 누르면 남은 %로 돌아옴', svgOf('0_2').includes('>73%<') && svgOf('0_2').includes('>LEFT<') && svgOf('2_2').includes('>12<'));

  send({ cmd: 'run', uuid: `${P}.more`, key: '4_1', actionid: 'a4_1' });
  await sleep(400);
  snap('더보기를 누른 뒤 (2페이지)');
  check('2페이지 첫 칸은 10번째 세션', svgOf('0_0').includes('온보딩'));
  check('더보기 키에 2/2', svgOf('4_1').includes('2/2'));

  send({ cmd: 'run', uuid: `${P}.slot`, key: '0_0', actionid: 'a0_0' });
  await sleep(600);
  check('세션 키를 누르면 terminal switch 호출', fs.readFileSync(LOG, 'utf8').includes('terminal switch --terminal h9'));

  setState({ terminals: terminals.slice(0, 2), agents: agents.slice(0, 2) });
  await sleep(2600);
  snap('세션 2개로 줄어듦');
  check('줄어들면 1페이지로 돌아오고 앞에서부터 채움', svgOf('0_0').includes('로그인') && svgOf('1_0').includes('Refactor'));
  check('남은 칸은 빈 슬롯', !svgOf('2_0').includes('<text'));
  check('더보기는 2 SHOWN', svgOf('4_1').includes('2 SHOWN'));

  setState({ terminals: [], agents: [] });
  await sleep(2600);
  snap('세션 없음');
  check('세션이 없으면 첫 칸에 NO SESSIONS', svgOf('0_0').includes('NO SESSIONS'));

  setState({ fail: true });
  await sleep(2600);
  snap('Orca 꺼짐');
  check('Orca가 꺼지면 첫 칸에 OFFLINE', svgOf('0_0').includes('OFFLINE'));
  check('한도 키는 Orca와 무관하게 유지', svgOf('0_2').includes('>73%<'));

  check('플러그인 stderr에 예외 없음', !/TypeError|ReferenceError|uncaught/i.test(stderr));
} catch (e) {
  results.push({ name: e.message, ok: false });
} finally {
  child.kill();
  wss.close();
}

if (PREVIEW) {
  const outDir = path.join(ROOT, 'test/out');
  fs.mkdirSync(outDir, { recursive: true });
  const cell = (url) => (url ? `<img src="${url}" width="144" height="144">` : '<div class="blank"></div>');
  const grid = (ic) => {
    let h = '<div class="deck">';
    for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) {
      if (r === 2 && c === 3) { h += '<div class="clock">D200H clock widget</div>'; continue; }
      if (r === 2 && c === 4) continue;
      h += cell(ic[`${c}_${r}`]);
    }
    return h + '</div>';
  };
  const html = `<!doctype html><meta charset="utf-8"><title>Orca Sessions preview</title>
<style>body{background:#111214;color:#ccc;font:14px -apple-system,sans-serif;padding:24px}
.deck{display:grid;grid-template-columns:repeat(5,144px);gap:6px;margin:8px 0 32px}
.blank{width:144px;height:144px;background:#000;border-radius:16px}
.clock{grid-column:span 2;height:144px;border-radius:16px;background:#1c1c20;display:flex;align-items:center;justify-content:center;color:#666}</style>
${snapshots.map((s) => `<h3>${s.title}</h3>${grid(s.icons)}`).join('\n')}`;
  fs.writeFileSync(path.join(outDir, 'preview.html'), html);
  console.log(`미리보기: ${path.join(outDir, 'preview.html')}`);
}

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 통과`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
