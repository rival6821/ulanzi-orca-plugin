// Orca CLI 호출 담당.
// Ulanzi Studio가 Finder/Dock에서 실행되면 PATH가 /usr/bin:/bin 정도뿐이라
// `orca`(그리고 그 안에서 쓰는 node)를 못 찾는 경우가 많다. 그래서
// 1) 로그인 셸의 PATH를 한 번 읽어 와서 합치고
// 2) 흔한 설치 위치를 직접 찾아본다.

import { execFile } from 'child_process';
import { access, constants } from 'fs/promises';
import os from 'os';
import path from 'path';
import { t } from './i18n.js';

const HOME = os.homedir();

// 앱 번들 안의 원본이 1순위. /usr/local/bin/orca는 root 소유 0700 심볼릭 링크로
// 깔리는 경우가 있어, 실행은 되지만 스크립트가 readlink로 앱 위치를 못 찾고 실패한다.
const CANDIDATES = [
  '/Applications/Orca.app/Contents/Resources/bin/orca',
  path.join(HOME, 'Applications/Orca.app/Contents/Resources/bin/orca'),
  '/usr/local/bin/orca',
  '/opt/homebrew/bin/orca',
  path.join(HOME, '.local/bin/orca'),
  path.join(HOME, 'bin/orca'),
  path.join(HOME, '.orca/bin/orca'),
  '/usr/local/bin/orca-ide',
  '/opt/homebrew/bin/orca-ide',
];

const EXTRA_PATH = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  path.join(HOME, '.local/bin'),
  path.join(HOME, 'bin'),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

function run(file, args, { timeout = 8000, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout, env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}

async function isExecutable(p) {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class OrcaClient {
  constructor() {
    this.customPath = '';
    this.resolvedPath = null;
    this.env = null;
  }

  setCustomPath(p) {
    const next = (p || '').trim();
    if (next !== this.customPath) {
      this.customPath = next;
      this.resolvedPath = null; // 다시 찾게 한다
    }
  }

  async buildEnv() {
    if (this.env) return this.env;
    const parts = new Set();
    // 로그인 셸 PATH (nvm, homebrew 등 사용자가 설정한 경로 포함)
    const shell = process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/zsh';
    const r = await run(shell, ['-lc', 'printf %s "$PATH"'], { timeout: 5000 });
    if (!r.error && r.stdout) r.stdout.split(':').forEach((d) => d && parts.add(d));
    (process.env.PATH || '').split(':').forEach((d) => d && parts.add(d));
    EXTRA_PATH.forEach((d) => parts.add(d));
    this.env = { ...process.env, PATH: [...parts].join(':') };
    return this.env;
  }

  async resolve() {
    if (this.resolvedPath) return this.resolvedPath;
    const env = await this.buildEnv();

    // 개발·테스트용: 가짜 orca를 쓰게 할 때
    if (process.env.ORCA_SESSIONS_ORCA_BIN) return (this.resolvedPath = process.env.ORCA_SESSIONS_ORCA_BIN);

    if (this.customPath) {
      if (await isExecutable(this.customPath)) return (this.resolvedPath = this.customPath);
      throw new OrcaError('orca_path_invalid', t(`No executable at the configured path: ${this.customPath}`, `지정한 경로에 실행 파일이 없습니다: ${this.customPath}`));
    }

    for (const c of CANDIDATES) {
      if (await isExecutable(c)) return (this.resolvedPath = c);
    }

    // 마지막 수단: 합친 PATH에서 찾기
    const r = await run('/bin/sh', ['-c', 'command -v orca || command -v orca-ide'], { env, timeout: 5000 });
    const found = r.stdout.trim().split('\n')[0];
    if (found && (await isExecutable(found))) return (this.resolvedPath = found);

    throw new OrcaError(
      'orca_not_found',
      t(
        'Could not find the orca command. Register the CLI in Orca under Settings → Experimental → CLI, or set the path in the plugin settings.',
        'orca 명령을 찾지 못했습니다. Orca의 Settings → Experimental → CLI에서 CLI를 등록하거나, 설정에서 경로를 직접 지정하세요.'
      )
    );
  }

  /** orca <args> --json 실행 후 result만 돌려준다. */
  async call(args, { timeout = 8000 } = {}) {
    const bin = await this.resolve();
    const env = await this.buildEnv();
    const r = await run(bin, [...args, '--json'], { env, timeout });

    const parsed = parseJson(r.stdout) || parseJson(r.stderr);
    if (parsed && typeof parsed === 'object') {
      if (parsed.ok === false || parsed.error) {
        const e = parsed.error || {};
        throw new OrcaError(e.code || 'orca_error', e.message || JSON.stringify(e));
      }
      return 'result' in parsed ? parsed.result : parsed;
    }

    if (r.error) {
      if (r.error.code === 'ENOENT') {
        this.resolvedPath = null;
        throw new OrcaError('orca_not_found', t(`Cannot run orca: ${bin}`, `orca를 실행할 수 없습니다: ${bin}`));
      }
      if (r.error.killed) throw new OrcaError('orca_timeout', t('orca is taking too long to respond. Make sure the Orca app is running.', 'orca 응답이 너무 늦습니다. Orca 앱이 켜져 있는지 확인하세요.'));
      const msg = (r.stderr || r.error.message || '').trim().split('\n').slice(-1)[0];
      throw new OrcaError('orca_failed', msg || t('orca failed to run.', 'orca 실행에 실패했습니다.'));
    }
    throw new OrcaError('orca_bad_output', t('Could not read JSON from orca output.', 'orca 출력에서 JSON을 읽지 못했습니다.'));
  }

  async listTerminals() {
    const result = await this.call(['terminal', 'list']);
    const terminals = Array.isArray(result?.terminals) ? result.terminals : [];
    return { terminals, truncated: !!result?.truncated, totalCount: result?.totalCount ?? terminals.length };
  }

  /** worktree ps의 에이전트 상태(working/blocked/waiting/done)를 paneKey로 모은다. 실패하면 빈 Map. */
  async listAgents() {
    try {
      const result = await this.call(['worktree', 'ps', '--limit', '200']);
      const map = new Map();
      for (const wt of result?.worktrees || []) {
        for (const a of wt?.agents || []) if (a?.paneKey) map.set(a.paneKey, a);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  async focusTerminal(handle) {
    return this.call(['terminal', 'switch', '--terminal', handle]);
  }

  /** 터미널에 실제로 보이는 화면의 줄들 */
  async readScreen(handle) {
    const result = await this.call(['terminal', 'read', '--terminal', handle, '--screen', '--limit', '60']);
    return Array.isArray(result?.terminal?.tail) ? result.terminal.tail : [];
  }

  /** 키 입력을 그대로 보낸다 (Enter 없이). 숫자 = 선택지, '\x1b' = Esc, '\x1b[Z' = Shift+Tab */
  async sendKeys(handle, text) {
    return this.call(['terminal', 'send', '--terminal', handle, '--text', text]);
  }

  /** 에이전트에게 문구를 보내고 Enter (Orca가 붙여넣기로 감싸 준다) */
  async sendPrompt(handle, text) {
    return this.call(['terminal', 'send', '--terminal', handle, '--text', text, '--enter']);
  }

  /** 같은 워크트리에 같은 에이전트(claude, codex …)를 새로 띄우고 그 탭으로 전환 */
  async launchAgent(agent, worktreePath) {
    return this.call(['agent', 'launch', '--agent', agent, '--worktree', `path:${worktreePath}`, '--focus'], { timeout: 20000 });
  }

  async activateApp() {
    // Orca 창을 앞으로. 실패해도 무시한다.
    if (process.env.ORCA_SESSIONS_TEST) return;
    await run('/usr/bin/open', ['-a', 'Orca'], { timeout: 3000 });
  }
}

export class OrcaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 승인 화면의 번호 선택지를 읽는다. Claude Code·Codex 모두 이런 모양이다:
 *   ❯ 1. Yes
 *     2. Yes, and don't ask again for …
 *     3. No, and tell Claude what to do differently (esc)
 * 1부터 이어지는 마지막 묶음(2개 이상)만 쓴다. 못 읽으면 빈 배열.
 */
export function parseOptions(lines) {
  let group = [];
  let last = [];
  for (const line of lines) {
    const m = /^[\s│|]*(?:[❯›>▶➤→*]\s*)?(\d)[.)]\s+(.+?)[\s│|]*$/u.exec(String(line));
    if (!m) continue;
    const n = Number(m[1]);
    if (n === 1) group = [];
    else if (!group.length || group[group.length - 1].n !== n - 1) continue;
    group.push({ n, label: m[2].replace(/\s*\((?:esc|[a-z])\)\s*$/i, '').trim() });
    if (group.length >= 2) last = group;
  }
  return last;
}

/** Claude Code 아래 상태 줄의 권한 모드 (Shift+Tab으로 돈다) */
export function parseMode(lines) {
  const tail = lines.slice(-12).join('\n');
  if (/plan mode on/i.test(tail)) return 'PLAN';
  if (/accept edits on/i.test(tail)) return 'AUTO EDIT';
  if (/bypass permissions on/i.test(tail)) return 'BYPASS';
  return 'DEFAULT';
}

function parseJson(text) {
  if (!text) return null;
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    // 앞뒤에 로그가 섞인 경우: 첫 '{'부터 마지막 '}'까지 시도
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(t.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
