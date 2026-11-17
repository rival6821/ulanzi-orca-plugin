// Orca CLI 호출 담당.
// Ulanzi Studio가 Finder/Dock에서 실행되면 PATH가 /usr/bin:/bin 정도뿐이라
// `orca`(그리고 그 안에서 쓰는 node)를 못 찾는 경우가 많다. 그래서
// 1) 로그인 셸의 PATH를 한 번 읽어 와서 합치고
// 2) 흔한 설치 위치를 직접 찾아본다.

import { execFile } from 'child_process';
import { access, constants } from 'fs/promises';
import os from 'os';
import path from 'path';

const HOME = os.homedir();

const CANDIDATES = [
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
      throw new OrcaError('orca_path_invalid', `지정한 경로에 실행 파일이 없습니다: ${this.customPath}`);
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
      'orca 명령을 찾지 못했습니다. Orca의 Settings → Experimental → CLI에서 CLI를 등록하거나, 설정에서 경로를 직접 지정하세요.'
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
        throw new OrcaError('orca_not_found', `orca를 실행할 수 없습니다: ${bin}`);
      }
      if (r.error.killed) throw new OrcaError('orca_timeout', 'orca 응답이 너무 늦습니다. Orca 앱이 켜져 있는지 확인하세요.');
      const msg = (r.stderr || r.error.message || '').trim().split('\n').slice(-1)[0];
      throw new OrcaError('orca_failed', msg || 'orca 실행에 실패했습니다.');
    }
    throw new OrcaError('orca_bad_output', 'orca 출력에서 JSON을 읽지 못했습니다.');
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
