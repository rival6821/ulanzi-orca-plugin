#!/usr/bin/env node
// 가짜 orca CLI. 상태는 ORCA_FAKE_STATE 파일(JSON)에서 읽는다.
//   { terminals: [...], agents: [...], fail?: true }
const fs = require('fs');
const statePath = process.env.ORCA_FAKE_STATE;
const args = process.argv.slice(2);
if (process.env.ORCA_FAKE_LOG) fs.appendFileSync(process.env.ORCA_FAKE_LOG, args.join(' ') + '\n');
const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const out = (o) => console.log(JSON.stringify(o));

if (st.fail) {
  out({ ok: false, error: { code: 'runtime_unavailable', message: 'Orca is not running.' } });
  process.exit(1);
}
const [group, cmd] = args;
if (group === 'terminal' && cmd === 'list') {
  out({ ok: true, result: { terminals: st.terminals || [], totalCount: (st.terminals || []).length, truncated: false } });
} else if (group === 'worktree' && cmd === 'ps') {
  out({ ok: true, result: { worktrees: [{ worktreeId: 'w', path: '/w', agents: st.agents || [] }] } });
} else if (group === 'terminal' && cmd === 'read') {
  const h = args[args.indexOf('--terminal') + 1];
  out({ ok: true, result: { terminal: { handle: h, status: 'running', source: 'screen', tail: (st.screens || {})[h] || [] } } });
} else if (group === 'terminal' && cmd === 'switch') {
  const h = args[args.indexOf('--terminal') + 1];
  if (!(st.terminals || []).some((t) => t.handle === h)) {
    out({ ok: false, error: { code: 'terminal_handle_stale', message: 'stale handle' } });
    process.exit(1);
  }
  out({ ok: true, result: { focus: { handle: h, navigated: true } } });
} else {
  out({ ok: true, result: {} });
}
