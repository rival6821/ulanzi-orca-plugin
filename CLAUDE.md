# CLAUDE.md

Ulanzi D200H용 Ulanzi Studio 플러그인. Orca(Stably AI의 에이전트 개발 환경)의 세션과 Claude·Codex 남은 한도를 키에 띄운다. macOS 전용. 사용자 문서는 한국어로 쓴다.

**답변은 항상 한국어로 한다.**

## 명령

- `npm run setup` — 플러그인 폴더에 런타임 의존성 설치 (`ws`, 그리고 RUNNING GIF용 `@resvg/resvg-wasm`·`gifenc`)
- `npm test` — 시나리오 테스트. 코드를 바꾸면 반드시 실행
- `npm run preview` — `test/out/preview.html`로 키 모양 확인. 렌더러를 바꾸면 눈으로 확인
- `npm run install:local` — 실제 Ulanzi Studio에 복사 설치. 재시작은 `pkill -x UlanziDeck; sleep 4; open -a "Ulanzi Studio"` (프로세스 이름은 `Ulanzi Studio`가 아니라 `UlanziDeck`. 남은 옛 플러그인 node 프로세스가 있으면 `pgrep -fl orcasessions`로 찾아 종료)

## 구조

- 플러그인 폴더 `com.ulanzi.orcasessions.ulanziPlugin/`가 그대로 설치 단위다. 빌드 단계 없음, ES 모듈(`"type": "module"`), Ulanzi Studio 내장 Node 20에서 `plugin/app.js`를 직접 실행한다.
- `plugin/ulanzi/`(common-node)와 `libs/`(common-html)는 울란지 공식 SDK 사본. 수정하지 않는다. 출처: https://github.com/UlanziTechnology/UlanziDeckPlugin-SDK
- 액션 4개, UUID는 `com.ulanzi.ulanzistudio.orcasessions.{slot,more,usage,buddy}`. 메인 서비스 UUID는 반드시 4구간, 액션은 5구간 이상 — SDK가 구간 수로 메인/설정 화면을 구분한다.
- 설정 화면 하나(`property-inspector/inspector.html`)를 네 액션이 같이 쓰고, 쿼리의 `uuid`로 어느 액션인지 판단해 해당 `fieldset`만 켠다. 꺼진 fieldset의 입력은 저장 대상에서 빠진다.

## 데이터 출처

### 세션 (orca CLI)
- `orca terminal list --json` → `result.terminals[]`: `handle, tabId, leafId, title, paneTitle, worktreePath, branch, connected, lastOutputAt, agentIdentity, exitCause, orphaned`
- `orca worktree ps --limit 200 --json` → `result.worktrees[].agents[]`: `paneKey, state(working|blocked|waiting|done), agentType, conversationName, displayName, taskTitle, toolName`
- 둘은 `paneKey === tabId + ':' + leafId`로 잇는다.
- 상태 매핑: working → RUNNING, blocked(도구 승인 대기) → PERMIT?, waiting(AI가 낸 질문·선택지 대기, 예: `AskUserQuestion`) → CHOOSE?, done → IDLE, exitCause/연결 끊김 → ENDED. 단, `state: working` + `workingMode: 'monitoring'`(턴은 끝났고 백그라운드 모니터링만 도는 중)이면 `mainAgent.state`/`mainAgent.stateStartedAt`을 쓰고, 쉬는 중이면 회색 WATCHING(회전 없음)으로 띄운다. ps 행이 없으면 `lastOutputAt`으로 RUNNING/IDLE만 추정하고, 주황(승인 필요)은 추정으로 띄우지 않는다.
- 키를 짧게 누르면 `orca terminal switch --terminal <handle>` 후 `open -a Orca`.
- 길게(0.5초) 누르면 세션 슬롯·더보기 키들이 상세 화면이 된다(한도 키는 그대로, 60초 안 누르면 목록으로). 키가 작아 글자 정보 카드는 넣지 않고 누르면 동작하는 버튼만 둔다.
  - 윗줄: BACK · 세션 · OPEN(`terminal switch`) · MODE(Claude만, Shift+Tab `\x1b[Z`, 이름은 화면 아래 상태 줄을 `parseMode`로) · NEW(`agent launch --agent <같은 에이전트> --worktree path:<같은 워크트리> --focus`)
  - 아랫줄: 승인 대기 = 화면의 선택지 + ESC, 작업 중 = STOP(Esc), 쉬는 중 = 빠른 답장(설정 `replies`, 최대 4개, `terminal send --text … --enter`)
  - 선택지는 `orca terminal read --screen`의 번호 줄(`1. Yes` …)을 `parseOptions`로 읽는다. 누르면 `terminal send --text <번호>`, ESC/STOP은 `--text $'\x1b'`.
  - 보내기 직전에 `worktree ps`를 다시 읽어 같은 요청(`paneKey@stateStartedAt`)이 아직 blocked/waiting일 때만 보낸다. 이 확인은 빼지 말 것.
  - 짧게/길게는 `keydown`/`keyup`으로 가르고, keydown을 보낸 적 있는 키는 `run`을 무시한다(run만 오는 호스트·테스트는 run = 짧게).
- 핸들은 Orca 재시작 시 바뀐다. 매 폴링마다 목록을 새로 받으므로 저장하지 않는다.
- Orca 소스(참고용): https://github.com/stablyai/orca — CLI 스펙은 `src/cli/specs/`, 결과 타입은 `src/shared/terminal/runtime/runtime-terminal-contracts.ts`, `src/shared/worktree/catalog/runtime-worktree-contracts.ts`

### 남은 한도 (Orca 상태 표시줄과 같은 방식)
- Orca CLI에는 한도 조회 명령이 없다. Orca 앱 소스 `src/main/rate-limits/providers/{claude,codex}`와 같은 방식으로 직접 조회한다.
- Claude: 키체인 `Claude Code-credentials`의 `claudeAiOauth.accessToken` → `GET https://api.anthropic.com/api/oauth/usage` (헤더 `anthropic-beta: oauth-2025-04-20`). `five_hour`, `seven_day`, Fable 주간은 `limits[]`의 `weekly_scoped`.
- Codex: `~/.codex/auth.json`의 `tokens.access_token`, `account_id` → `GET https://chatgpt.com/backend-api/wham/usage`. 창 길이(`limit_window_seconds`)로 5H/7D를 나눈다.
- 둘 다 비공식 엔드포인트. 토큰은 메모리에만 두고, 로그·설정·다른 주소로 절대 보내지 않는다. 토큰을 새로 고치거나 쓰는 동작은 하지 않는다(401이면 키체인을 다시 읽기만).
- 기본 5분 주기, 429·네트워크 오류는 지수 백오프(최대 30분), 실패 시 마지막 값을 흐리게 + `Nm ago`.

## D200H 레이아웃

- 키 이름은 `열_행` (`0_0`이 왼쪽 위). 5열 × 3행이고, 아랫줄 오른쪽 두 칸(`3_2`,`4_2`)은 기본 시계 위젯이라 쓸 수 있는 키는 13개.
- 권장 배치: 위 두 줄 = 세션 슬롯 9 + 더보기(`4_1`), 아랫줄 `0_2..2_2` = 한도 3개.
- 한도 키는 기본 사용한 %(USED). 누르면 모든 한도 키가 남은 %(LEFT)로 같이 바뀐다(메모리에만, 재시작하면 USED). 조회 오류가 있는 키는 누르면 전환 대신 다시 조회.
- 한도 키 자동 배정: 3개 이하면 `claude-5h, claude-week, codex-pair`, 4개 이상이면 개별 지표.
- 슬롯은 행→열 순으로 정렬. 실제 기기에서 키 이름 형식이 다르면 설정의 "슬롯 순서" 수동 지정으로 우회.

## 디자인 규칙 (AgentDeck 따름)

- 렌더러는 AgentDeck `shared/src/svg-renderers/session-slot-renderer.ts`와 `shared/src/d200h-layout.ts`, 토큰은 `design/tokens.css`에서 옮겨 왔다 (MIT, THIRD-PARTY-NOTICES.md). 새 키 모양을 만들 때도 그쪽 구성과 토큰을 먼저 본다: https://github.com/puritysb/AgentDeck
- 색은 의미가 하나씩: 청록 #2DD4BF = 작업 중, 주황 #FFA93D = 사람이 필요함(PERMIT?·CHOOSE?, 유일하게 강조되는 색), 초록 #52D988 = 세션 키에선 방금 끝남(DONE), 초록/주황/빨강 = 한도 심각도(사용 70%/90% 기준), 회색 = 정보 없음.
- 에이전트·회사 로고는 넣지 않는다. 이름 + AgentDeck의 브랜드 강조색만 쓴다. 단, Claude 캐릭터(Clawd, Claude Code 시작 화면의 주황 픽셀 캐릭터)는 넣어도 된다 — 버디 키(`buddy.js`)에 쓴다.
- 키 위 문구는 AgentDeck처럼 짧은 영어 대문자(RUNNING, IDLE, PERMIT?, CHOOSE?, DONE, MORE, 5H, 7D, USED, LEFT). 설정 화면과 문서는 한국어.
- 키 캔버스는 144×144 SVG, `setBaseDataIcon`에 `data:image/svg+xml;base64,…`로 보낸다(울란지 공식 데모와 같은 방식). 같은 그림이면 다시 보내지 않도록 마지막 data URL을 캐시한다 — SVG 안에 무작위 id를 넣지 말 것.
- 움직이는 키는 GIF다: RUNNING = 테두리 회전, PERMIT?·CHOOSE? = 주황 깜빡임(빠르게), DONE = 초록 깜빡임(천천히). DONE은 `worktree ps`의 `stateStartedAt`이 5분 이내인 done이고, 그 키를 누르면(`paneKey@stateStartedAt` 기억) IDLE로 돌아간다. 만드는 법(`gif.js`, AgentDeck과 같은 resvg wasm → gifenc). 정적 SVG를 먼저 보내고, GIF가 준비됐을 때 그 키 그림이 그대로면 `setGifDataIcon`으로 바꿔 끼운다. GIF는 정적 data URL을 키로 캐시하고, 이미 만든 GIF면 정적 SVG 없이 GIF만 보낸다(키마다 두 번 보내면 실기기에서 페이지 전환이 눈에 띄게 느림). 다른 페이지 GIF를 미리 만들어 첫 방문에도 GIF만 보내 봤더니 실기기 체감이 오히려 느려져 뺐다. 폰트는 시스템 `AppleSDGothicNeo.ttc`를 읽는다. GIF를 못 만들면 정적 SVG가 그대로 남는다.
- 세션 키 제목·선택지 문구는 22→16px 중 잘리지 않고 들어가는 가장 큰 크기, 최대 4줄(`fitBlock`). 5줄·14px은 실기기에서 안 읽힌다. 브랜치·도구 줄과 에이전트 색 점은 없다(작아서 안 읽히고, Claude 점이 PERMIT? 주황과 헷갈림). 에이전트 색은 IDLE 글자에만.
- 버디 키(`buddy.js`): Clawd를 Claude Code 시작 화면 블록 문자에서 옮긴 18×10 픽셀로 그리고, 전체 상황(Orca 꺼짐 > 승인·질문 대기 > 방금 끝남 > 작업 중 > 쉬는 중, 한도 90%↑면 땀)에 따라 8프레임 GIF. 항상 GIF라 배경은 단색(그라데이션은 GIF에서 띠가 생김). 누르면 가장 급한 세션으로 전환, 급한 게 없으면 `REACTIONS` 중 하나(직전과 다른 것)를 GIF 두 바퀴 동안 보여 주고 IDLE로, Orca 꺼짐이면 `open -a Orca`. 글꼴에 없는 기호(예: ♫)는 GIF에서 네모로 나오니 쓰지 말 것.
- 글자 폭은 `render.js`의 `charEm` 추정치로 줄바꿈한다. 한글은 1em. 넘치면 추정치를 고친다.

## 주의할 점

- Ulanzi Studio를 Finder/Dock에서 띄우면 PATH가 짧아 `orca`(와 그 안의 node)를 못 찾는다. `orca.js`가 로그인 셸 PATH를 합치고 흔한 위치를 찾는다. 사용자가 경로를 직접 지정할 수도 있다.
- `/usr/local/bin/orca`가 root 소유 0700 심볼릭 링크면 실행은 되지만 Orca 스크립트가 readlink에 실패한다(`Unable to determine Orca.app path from symlink`). 그래서 앱 번들 안 `Contents/Resources/bin/orca`를 1순위로 찾는다.
- 공통 설정은 여러 키가 각자 저장하므로 `savedAt`이 가장 큰 값이 이긴다. 슬롯 순서·한도 지표만 키별 값.
- `setSettings`는 액션이 비활성일 때 저장되지 않는다(SDK 제약). 설정은 설정 화면 → `sendParamFromPlugin` 경로로만 받는다.
- 테스트 전용 환경 변수: `ORCA_SESSIONS_TEST`(키체인·`open -a` 건너뜀), `ORCA_SESSIONS_ORCA_BIN`(가짜 orca 경로). 이 외의 동작을 바꾸는 데 쓰지 말 것.

## 아직 확인 못 한 것 / 할 일

- [ ] 실제 D200H에서 키 이름 형식과 슬롯 순서 확인
- [ ] 실제 Orca에서 `worktree ps`의 `paneKey`와 `terminal list`의 `tabId:leafId`가 맞물리는지 확인 (안 맞으면 `recordedPaneKey`나 `worktreeId`로 보조 매칭)
- [ ] Ulanzi Studio가 SVG data URL을 그대로 그리는지 실기기 확인 (안 되면 PNG 래스터화 필요 — AgentDeck은 resvg wasm 사용)
- [x] RUNNING 회전·PERMIT?/DONE 깜빡임 (GIF) — 실기기에서 `setGifDataIcon`이 도는지 확인 필요
- [ ] 실제 Claude Code·Codex 승인 화면에서 숫자 키 하나로 선택이 되는지, `--screen` 줄 모양이 `parseOptions`에 맞는지 확인
- [ ] 실기기에서 keydown/keyup/run 순서 확인 (길게 누를 때 짧은 동작이 같이 나가지 않는지)
- [ ] 키 문구 한국어 옵션
