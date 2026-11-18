# Orca 세션 — Ulanzi D200H 플러그인 (macOS)

Orca에서 돌고 있는 에이전트 세션과 Claude·Codex 남은 한도를 Ulanzi 키에 띄웁니다.
"세션 슬롯" 액션을 여러 키에 깔아 두면, 세션이 생길 때 다음 빈 키에 들어가고
세션이 닫히면 빠지면서 뒤쪽이 한 칸씩 당겨집니다.

## 준비

1. Orca에서 **Settings → Experimental → CLI**로 `orca` CLI를 등록합니다.
2. 터미널에서 `orca terminal list --json`이 동작하는지 확인합니다.

## 설치

1. `com.ulanzi.orcasessions.ulanziPlugin` 폴더를 아래 위치로 옮깁니다. (이전 버전이 있으면 덮어쓰기)
   ```
   ~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/
   ```
2. Ulanzi Studio를 완전히 종료했다가 다시 엽니다.
3. 액션 목록의 **Orca** 분류에서 키에 드래그합니다. D200H 추천 배치:
   - 위 두 줄(10칸): **세션 슬롯** 9개 + 둘째 줄 마지막 칸에 **더보기**
   - 아랫줄 왼쪽 3칸: **남은 한도** 3개 → Claude 5H, Claude 7D, Codex 5H+7D(한 키에 두 줄)가 자동 배정됩니다. 오른쪽 넓은 칸은 D200H 기본 시계 위젯 자리입니다.

## 디자인

키 디자인은 [AgentDeck](https://puritysb.github.io/AgentDeck/)의 D200H 렌더러를 따릅니다 (MIT, THIRD-PARTY-NOTICES.md 참고). 브랜드 로고 대신 에이전트 이름과 브랜드 색만 씁니다.

## 세션 키 읽는 법

| 모양 | 뜻 |
|---|---|
| **RUNNING** · 청록 테두리가 빙글빙글 돎 | 에이전트가 작업 중 |
| **PERMIT?** · 주황 테두리 깜빡임 + PERM | 승인·응답이 필요함 (Orca가 blocked로 알려준 경우만) |
| **DONE** · 초록 테두리 깜빡임 | 방금 끝남. 1분이 지나거나 키를 누르면 IDLE로 |
| **IDLE** · 에이전트 색 글자 | 턴을 마치고 다음 지시를 기다림 |
| **ENDED** · 회색 | 종료된 세션 |
| 빈 어두운 칸 | 빈 슬롯 |
| **NO SESSIONS** | 표시할 세션이 없음 |
| **OFFLINE** · 청록 카드 | Orca에 연결 못 함. 누르면 다시 시도 |

상태는 Orca의 `worktree ps`가 주는 에이전트 상태(working/blocked/done)를 그대로 씁니다. 오래된 Orca라 상태가 없으면 마지막 출력 시각으로 RUNNING/IDLE만 추정하고, 주황색은 추정으로 띄우지 않습니다.

세션 키를 누르면 Orca가 그 세션으로 전환되고 Orca 창이 앞으로 옵니다.

**MORE 키**: 세션이 슬롯보다 많으면 `+N · 1/2`처럼 숨은 개수와 페이지가 보이고, 누를 때마다 다음 페이지로 넘어갑니다. 다 들어가면 회색으로 `N SHOWN`이 보입니다. MORE 키를 안 두면 넘칠 때 마지막 세션 슬롯이 대신합니다.

## 남은 한도 키

- 큰 숫자가 **남은** 비율(`73%LEFT`)이고, 배경의 물높이도 남은 양입니다. 한도 키를 누르면 모든 한도 키가 **사용한** 비율(`27%USED`)로 바뀌고, 다시 누르면 돌아옵니다. 색은 AgentDeck 기준대로 사용량 70% 미만 초록, 90% 미만 주황, 그 이상 빨강입니다.
- 아래 숫자는 초기화까지 남은 시간(`2h13m`, `2d23h`)입니다.
- 두 줄짜리 키(Codex 5H+7D)는 위아래로 각 창의 남은 %, 초기화 시간, 막대를 보여줍니다.
- 기본 5분마다 확인합니다. 조회가 실패하면 마지막 값을 흐리게 하고 `12m ago`처럼 언제 값인지 표시합니다.
- 키마다 설정에서 표시할 한도를 고를 수 있습니다: Claude 5시간 / 주간 / Fable 주간 / 5시간+주간, Codex 5시간 / 주간 / 5시간+주간.

**어디서 값을 가져오나**: Orca 상태 표시줄과 같은 방식입니다. Claude는 Claude Code 로그인 토큰(macOS 키체인 `Claude Code-credentials`)으로 `api.anthropic.com`의 사용량 조회 주소에, Codex는 `~/.codex/auth.json`의 토큰으로 `chatgpt.com`의 사용량 조회 주소에 묻습니다. 토큰은 메모리에만 두고 다른 곳으로 보내지 않으며, 로그에도 남기지 않습니다. 둘 다 공식 공개 API가 아니라서 회사 쪽 변경으로 동작이 바뀔 수 있습니다.

**처음 한 번 키체인 창**: Claude 한도를 처음 읽을 때 macOS가 "security이(가) 키체인의 'Claude Code-credentials'에 접근하려고 합니다" 창을 띄울 수 있습니다. 로그인 암호를 넣고 **항상 허용**을 누르면 다음부터는 묻지 않습니다.

## 설정 (키를 선택하면 오른쪽에 나옴)

세션 슬롯·더보기 키 공통: 표시할 세션(에이전트만/모든 터미널), 누르면(전환+앞으로/전환만), 새로고침 주기(기본 2초), 작업 중 판정(기본 5초), orca 경로(비우면 자동). 세션 슬롯만: 슬롯 순서(기본 키 위치 순, 어긋나면 키마다 번호 지정).

남은 한도 키: 표시할 한도(기본 자동), 한도 확인 주기(기본 5분).

## 문제 해결

- **빨간 키에 "orca 명령을 찾지 못했습니다"**: 터미널에서 `which orca`를 실행해 나온 경로를 설정의 orca 경로에 붙여 넣으세요.
- **키가 계속 비어 있음**: Orca 버전이 오래되어 에이전트 식별 정보(`agentIdentity`)가 없으면 "에이전트만"에서 아무것도 안 보일 수 있습니다. "모든 터미널"로 바꿔 보세요.
- **노란색/파란색 판정이 어긋남**: "작업 중 판정" 초를 늘리거나 줄여 보세요.
- **한도 키에 `sign-in expired`**: Claude Code나 Codex를 한 번 실행하면 토큰이 갱신되고, 키를 누르면 다시 읽습니다(오류가 떠 있는 키는 누르면 전환 대신 다시 조회).
- **한도 키가 흐리고 `12m ago`**: 최근 조회가 실패해서 마지막으로 받은 값을 보여주는 중입니다. 너무 자주 묻다가 거절되면 자동으로 간격을 늘립니다.
- **디버깅**: Ulanzi Studio를 `--log --nodeRemoteDebug` 옵션으로 실행하고 Chrome의 `chrome://inspect`에서 확인할 수 있습니다.

## 구조

```
plugin/app.js      메인 서비스: 폴링, 슬롯 배정, 키 입력 처리
plugin/orca.js     orca CLI 실행 (macOS PATH 보정 포함)
plugin/usage.js    Claude·Codex 남은 한도 조회
plugin/render.js   키 이미지(SVG) 그리기 (AgentDeck 디자인)
plugin/ulanzi/     울란지 공식 Node SDK (Apache-2.0)
libs/              울란지 공식 HTML SDK (설정 화면용, Apache-2.0)
property-inspector/inspector.html  설정 화면 (세 액션 공용)
node_modules/ws    SDK가 쓰는 WebSocket 라이브러리
```
