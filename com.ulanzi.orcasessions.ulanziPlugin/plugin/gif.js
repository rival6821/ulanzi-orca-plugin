// SVG 프레임들 → 움직이는 GIF(base64). RUNNING 테두리 회전에 쓴다.
// AgentDeck src/gif.ts, src/raster.ts와 같은 방식(resvg wasm으로 래스터화 → gifenc로 인코딩).
// 폰트는 따로 싣지 않고 macOS 시스템 폰트(Apple SD Gothic Neo: 한글+영문)를 읽는다.
// 준비가 안 되거나 실패하면 null — 호출하는 쪽은 정적 SVG를 그대로 둔다.

import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const require = createRequire(import.meta.url);

const FONT_FILES = ['/System/Library/Fonts/AppleSDGothicNeo.ttc', '/System/Library/Fonts/Helvetica.ttc'];
const PALETTE_COLORS = 64;
const TRANSPARENT = 0;

let ready = null;
let font = null;

function init() {
  ready ??= (async () => {
    await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    // ponytail: 55MB 폰트를 프레임마다 wasm에 복사한다(프레임당 ~20ms). 느려지면 글자층을 한 번만 그려 합성.
    font = {
      fontBuffers: FONT_FILES.filter(existsSync).map((p) => new Uint8Array(readFileSync(p))),
      loadSystemFonts: false,
      defaultFontFamily: 'Apple SD Gothic Neo',
    };
  })();
  return ready;
}

const tick = () => new Promise((r) => setImmediate(r));

function rgba(svg) {
  const img = new Resvg(svg, { font }).render();
  return { data: new Uint8Array(img.pixels), width: img.width, height: img.height };
}

/** @returns {Promise<string|null>} GIF base64 (접두어 없음) */
export async function framesToGif(svgs, delayMs) {
  try {
    await init();
    const images = [];
    for (const s of svgs) {
      images.push(rgba(s));
      await tick();
    }
    const merged = new Uint8Array(images.reduce((n, i) => n + i.data.length, 0));
    images.reduce((at, i) => (merged.set(i.data, at), at + i.data.length), 0);
    const palette = quantize(merged, PALETTE_COLORS - 1, { format: 'rgba4444', oneBitAlpha: true })
      .filter((c) => (c[3] ?? 255) !== 0);
    palette.unshift([0, 0, 0, 0]);

    const gif = GIFEncoder();
    let prev = null;
    images.forEach((img, i) => {
      const index = applyPalette(img.data, palette, 'rgba4444');
      const cur = new Uint32Array(img.data.buffer, img.data.byteOffset, img.data.length >> 2);
      // 앞 프레임과 같은 픽셀은 투명으로 → 바뀐 테두리만 담겨 작아진다 (dispose 1로 앞 프레임 유지)
      if (prev) for (let p = 0; p < index.length; p++) if (cur[p] === prev[p]) index[p] = TRANSPARENT;
      prev = cur;
      gif.writeFrame(index, img.width, img.height, {
        palette: i === 0 ? palette : undefined,
        delay: delayMs, transparent: true, transparentIndex: TRANSPARENT, repeat: 0, first: i === 0, dispose: 1,
      });
    });
    gif.finish();
    return Buffer.from(gif.bytes()).toString('base64');
  } catch (e) {
    console.error('[orca-sessions] GIF 만들기 실패:', e?.message || e);
    return null;
  }
}
