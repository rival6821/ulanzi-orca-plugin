// 사용량 API 가짜 응답. node --import 로 플러그인보다 먼저 로드된다.
import fs from 'fs';
const now = Date.now();
globalThis.fetch = async (url) => {
  if (process.env.ORCA_FAKE_LOG) fs.appendFileSync(process.env.ORCA_FAKE_LOG, `fetch ${url}\n`);
  let body;
  if (url.includes('anthropic.com')) {
    body = {
      five_hour: { utilization: 27, resets_at: new Date(now + (2 * 60 + 14) * 60000).toISOString() },
      seven_day: { utilization: 64, resets_at: new Date(now + 3 * 86400000).toISOString() },
    };
  } else {
    body = {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 88, limit_window_seconds: 18000, reset_at: Math.floor(now / 1000) + 40 * 60 },
        secondary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: Math.floor(now / 1000) + 2 * 86400 },
      },
    };
  }
  return { ok: true, status: 200, json: async () => body };
};
