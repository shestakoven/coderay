// Renders icon.svg into icon.png (the dev dock icon) and icon.icns (the built app), each size from the vector.
//   node packages/desktop/build/make-icon.mjs
// Needs Chromium from Playwright and macOS iconutil.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const svg = pathToFileURL(join(here, 'icon.svg')).href;
const work = mkdtempSync(join(tmpdir(), 'coderay-icon-'));
const page = join(work, 'page.html');
const iconset = join(work, 'icon.iconset');
mkdirSync(iconset);

const FILES = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];

const browser = await chromium.launch();
try {
  const tab = await browser.newPage();
  const render = async (size, out) => {
    writeFileSync(page, `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style><img src="${svg}" width="${size}" height="${size}">`);
    await tab.setViewportSize({ width: size, height: size });
    await tab.goto(pathToFileURL(page).href);
    await tab.waitForFunction(() => document.images[0].complete && document.images[0].naturalWidth > 0);
    await tab.screenshot({ path: out, omitBackground: true });
  };
  for (const [name, size] of FILES) await render(size, join(iconset, name));
  await render(1024, join(here, 'icon.png'));
} finally {
  await browser.close();
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(here, 'icon.icns')]);
rmSync(work, { recursive: true, force: true });
