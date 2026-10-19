// Recreates the landing screenshots and the demo video from the real UI.
//   node site/capture/run.mjs            both
//   node site/capture/run.mjs --shots    site/assets/shots/*.png
//   node site/capture/run.mjs --video    site/assets/video/demo.{mp4,webm}, demo-poster.jpg, chapters.json
// CAPTURE_DEBUG=<file.png> keeps a screenshot of the page when the shots run fails.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO, startCore } from './core.mjs';
import { buildScenario, PROMPT } from './scenario.mjs';
import { installOverlay } from './overlay.mjs';

const SHOTS = join(REPO, 'site/assets/shots');
const VIDEO = join(REPO, 'site/assets/video');
const FFMPEG = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
const VIEWPORT = { width: 1440, height: 900 };
const VIDEO_SIZE = { width: 1920, height: 1200 };
const FPS = 30;

const args = process.argv.slice(2);
const wantShots = args.includes('--shots') || !args.includes('--video');
const wantVideo = args.includes('--video') || !args.includes('--shots');

const STEER_COMMENT = 'return 429 with a Retry-After header';
const STEER_ADD = 'audit log for blocked attempts';
const ASK_LINK = 'Why check the limit in the service, not the route?';
const ASK_PART = 'Is an in-memory window enough with several workers?';

// Panels as a user would leave them: the map and the agent side by side, the file tree folded away.
const PREFS = {
  'ide.panel-sizes': JSON.stringify({ left: 240, right: 400, bottom: 200 }),
  'ide.panels': JSON.stringify({ left: false, right: true, bottom: false }),
  'ide.review.prefs': JSON.stringify({ mode: 'unified', listWidth: 300, showContext: true, view: 'diff' }),
};

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// The empty middle of the title bar: hovering it opens no tooltip or popover (the status bar's activity item does).
const NEUTRAL = { x: 900, y: 18 };

// Two animation frames: the render a state change causes has happened.
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

async function quiet(page, selector = '.react-flow__node', ms = 400) {
  // Waits until the boxes under the selector stop moving (layout tweens, camera moves).
  let last = '';
  for (let i = 0; i < 40; i += 1) {
    const now = await page.evaluate((s) => JSON.stringify([...document.querySelectorAll(s)].map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)]; })), selector);
    if (now === last) return;
    last = now;
    await wait(ms / 2);
  }
}

// The maps fit themselves to the canvas but not around what floats over it (the step rail, the minimap, a draft,
// a details panel), and the plan map's own fit never zooms past 100 %. Zoom with the wheel and drag the background,
// as a user would, until the parts use the free room and nothing covers them.
const VIEWS = {
  plan: {
    canvas: '[data-testid="plan-flow"]', pinch: false, maxZoom: 1.4,
    over: ['[data-testid="flow-rail"]', '.pf-float.pf-row > *', '.map-view', '.map-regroup', '.react-flow__minimap', '.react-flow__controls', '[data-testid="steer-bar"]', '[data-testid="steer-draft"]', '[data-testid="flow-details"]', '[data-testid="steer-pop"]'],
  },
  overview: { canvas: '.map.ov', top: 80, pinch: true, maxZoom: 1.6, over: ['.react-flow__minimap', '.react-flow__controls'] },
  review: { canvas: '[data-testid="review-map"]', top: 76, pinch: true, maxZoom: 1.2, over: ['.react-flow__minimap', '[data-testid="review-map-details"]', '[data-testid="review-map-bar"]'] },
};

// What the framing works with, in screen pixels: the canvas, what covers it, the zoom, the parts (each with all it
// draws, such as a comment under a card), link labels, points along the links, and spots of bare background.
const measureView = (page, view) => page.evaluate(({ canvas, over }) => {
  const root = document.querySelector(canvas);
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom }; };
  const shown = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.opacity !== '0' && st.visibility !== 'hidden'; };
  const nodes = [...root.querySelectorAll('.react-flow__node')].filter(shown).map((node) => [node, ...node.querySelectorAll('*')].filter(shown).map(box).reduce((u, q) => ({ x: Math.min(u.x, q.x), y: Math.min(u.y, q.y), r: Math.max(u.r, q.r), b: Math.max(u.b, q.b) })));
  const union = nodes.reduce((u, n) => ({ x: Math.min(u.x, n.x), y: Math.min(u.y, n.y), r: Math.max(u.r, n.r), b: Math.max(u.b, n.b) }), { x: 1e9, y: 1e9, r: -1e9, b: -1e9 });
  const labels = [...root.querySelectorAll('.pf-elabel')].filter(shown).map(box);
  const points = [];
  for (const path of root.querySelectorAll('.react-flow__edge-path')) {
    if (!shown(path.closest('.react-flow__edge') ?? path)) continue;
    const m = path.getScreenCTM();
    const length = path.getTotalLength();
    for (let d = 0; d <= length; d += 16) {
      const p = path.getPointAtLength(d);
      points.push({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
    }
  }
  const rect = box(root);
  const covers = over.flatMap((selector) => [...document.querySelectorAll(selector)].filter(shown).map(box));
  const rail = document.querySelector('[data-testid="flow-rail"]');
  const zoom = Number(/scale\(([\d.]+)\)/.exec(root.querySelector('.react-flow__viewport').style.transform)?.[1] ?? 1);
  // Spots of bare background: one to drag from, and the one nearest the parts to zoom at, so no card lights up under the pointer.
  const bare = [];
  for (let y = rect.b - 30; y > rect.y + 60; y -= 24) {
    for (let x = rect.x + 90; x < rect.r - 30; x += 24) {
      if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) bare.push({ x, y });
    }
  }
  const mid = { x: (union.x + union.r) / 2, y: (union.y + union.b) / 2 };
  const still = bare.reduce((a, p) => (!a || Math.hypot(p.x - mid.x, p.y - mid.y) < Math.hypot(a.x - mid.x, a.y - mid.y) ? p : a), null);
  return { nodes, union, labels, points, rect, covers, rail: rail && shown(rail) ? box(rail) : null, zoom, grab: bare[0] ?? null, still };
}, view);

const currentZoom = (page, view) => page.evaluate((canvas) => Number(/scale\(([\d.]+)\)/.exec(document.querySelector(`${canvas} .react-flow__viewport`).style.transform)?.[1] ?? 1), view.canvas);

// d3-zoom scales by 2^(-deltaY * 0.002) per wheel event, ten times that for a pinch on a Mac; gain corrects the guess.
// On camera the zoom glides in small notches; for a still one notch is enough.
async function zoomBy(page, view, m, ratio, gain, smooth) {
  const want = Math.log2(ratio);
  const at = m.still ?? { x: (m.union.x + m.union.r) / 2, y: (m.union.y + m.union.b) / 2 };
  await page.mouse.move(at.x, at.y);
  if (view.pinch) await page.keyboard.down('Control');
  const notches = smooth ? 14 : 1;
  for (let n = 0; n < notches; n += 1) {
    await page.mouse.wheel(0, -want / ((view.pinch ? 0.02 : 0.002) * gain) / notches);
    if (smooth) await wait(22);
  }
  if (view.pinch) await page.keyboard.up('Control');
  await quiet(page, `${view.canvas} .react-flow__node`, 300);
  const got = Math.log2((await currentZoom(page, view)) / m.zoom);
  return Math.abs(got) > 1e-3 ? gain * (got / want) : gain;
}

async function dragBy(page, view, m, dx, dy, smooth) {
  if (!m.grab) throw new Error('no bare background to drag the map by');
  await page.mouse.move(m.grab.x, m.grab.y);
  await page.mouse.down();
  const steps = smooth ? 28 : 12;
  for (let n = 1; n <= steps; n += 1) {
    const k = smooth ? 0.5 - Math.cos((Math.PI * n) / steps) / 2 : n / steps;
    await page.mouse.move(m.grab.x + dx * k, m.grab.y + dy * k);
    if (smooth) await wait(14);
  }
  await page.mouse.up();
  await quiet(page, `${view.canvas} .react-flow__node`, 300);
}

// The plan map: the largest zoom ratio at which every part, link and label lies in the canvas and clear of what covers
// it; the parts may wrap around the step rail. Of the places that fit, the one nearest the middle of the room beside the rail.
function placePlan(m, from, to) {
  const pad = 12;
  const inside = { x: m.rect.x + 10, y: m.rect.y + 10, r: m.rect.r - 10, b: m.rect.b - 10 };
  const covers = m.covers.map((c) => ({ x: c.x - pad, y: c.y - pad, r: c.r + pad, b: c.b + pad }));
  const shapes = [...m.nodes, ...m.labels, ...m.points.map((p) => ({ x: p.x - 3, y: p.y - 3, r: p.x + 3, b: p.y + 3 }))];
  const target = { x: ((m.rail ? m.rail.r : m.rect.x) + m.rect.r) / 2, y: (m.rect.y + m.rect.b) / 2 };
  const hits = (q, bx, by) => covers.some((o) => q.x + bx < o.r && q.r + bx > o.x && q.y + by < o.b && q.b + by > o.y);
  for (let s = from; s >= to - 1e-9; s -= 0.02) {
    const scaled = shapes.map((q) => ({ x: q.x * s, y: q.y * s, r: q.r * s, b: q.b * s }));
    const u = scaled.reduce((a, q) => ({ x: Math.min(a.x, q.x), y: Math.min(a.y, q.y), r: Math.max(a.r, q.r), b: Math.max(a.b, q.b) }));
    let best = null;
    for (let bx = inside.x - u.x; bx <= inside.r - u.r; bx += 4) {
      for (let by = inside.y - u.y; by <= inside.b - u.b; by += 4) {
        const d = Math.hypot((u.x + u.r) / 2 + bx - target.x, (u.y + u.b) / 2 + by - target.y);
        if (best && d >= best.d) continue;
        if (scaled.some((q) => hits(q, bx, by))) continue;
        best = { s, bx, by, d };
      }
    }
    if (best) return best;
  }
  return null;
}

async function frame(page, name, { rest = NEUTRAL, smooth = false } = {}) {
  const view = VIEWS[name];
  await quiet(page, `${view.canvas} .react-flow__node`);
  let gain = 1;
  for (let i = 0; i < 10; i += 1) {
    const m = await measureView(page, view);
    let ratio;
    let dx;
    let dy;
    if (name === 'plan') {
      const fit = placePlan(m, view.maxZoom / m.zoom, 0.4);
      if (!fit) throw new Error('the plan map fits nowhere on the canvas');
      ratio = fit.s;
      dx = Math.round(fit.bx);
      dy = Math.round(fit.by);
    } else {
      const pad = 22;
      let free = [{ x: m.rect.x + pad, y: m.rect.y + view.top, r: m.rect.r - pad, b: m.rect.b - pad }];
      for (const c of m.covers) {
        const g = { x: c.x - pad, y: c.y - pad, r: c.r + pad, b: c.b + pad };
        free = free.flatMap((f) => (g.r <= f.x || g.x >= f.r || g.b <= f.y || g.y >= f.b
          ? [f]
          : [{ ...f, r: g.x }, { ...f, x: g.r }, { ...f, b: g.y }, { ...f, y: g.b }].filter((q) => q.r - q.x > 60 && q.b - q.y > 60)));
      }
      const w = m.union.r - m.union.x;
      const h = m.union.b - m.union.y;
      const scaleOf = (f) => Math.min((f.r - f.x) / w, (f.b - f.y) / h);
      const best = free.reduce((a, f) => (scaleOf(f) > scaleOf(a) ? f : a));
      ratio = Math.min(scaleOf(best), view.maxZoom / m.zoom) * 0.98;
      dx = Math.round((best.x + best.r) / 2 - (m.union.x + m.union.r) / 2);
      dy = Math.round((best.y + best.b) / 2 - (m.union.y + m.union.b) / 2);
    }
    if (Math.abs(ratio - 1) > 0.02) {
      gain = await zoomBy(page, view, m, ratio, gain, smooth);
      continue;
    }
    if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) break;
    await dragBy(page, view, m, dx, dy, smooth);
  }
  // The pointer goes back to where the viewer last saw it, so no card stays lit by a hover nobody made.
  await page.mouse.move(rest.x, rest.y);
  return currentZoom(page, view);
}

// The label of the review map link that runs between two parts: the one nearest the midpoint of their cards.
async function linkBetween(page, from, to) {
  const id = await page.evaluate(([a, b]) => {
    const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
    const p = center(document.querySelector(`[data-testid="review-map-part-${a}"]`));
    const q = center(document.querySelector(`[data-testid="review-map-part-${b}"]`));
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    const labels = [...document.querySelectorAll('[data-testid^="review-map-link-"]')];
    labels.sort((m, n) => { const c = center(m); const e = center(n); return Math.hypot(c.x - mid.x, c.y - mid.y) - Math.hypot(e.x - mid.x, e.y - mid.y); });
    return labels[0]?.getAttribute('data-testid');
  }, [from, to]);
  return page.getByTestId(id);
}

class Director {
  constructor(page, mode) {
    this.page = page;
    this.mode = mode;
    this.video = mode === 'video';
    this.chapters = [];
    this.zones = [];
    this.fastSince = null;
    this.marks = {};
    this.at = NEUTRAL;
  }

  async frame(name) {
    this.zoom = await frame(this.page, name, { rest: this.at, smooth: this.video });
  }

  mark(name) {
    if (this.video) this.marks[name] = Date.now() / 1000;
  }

  async shot(name) {
    if (this.video) return;
    // The map's activity panel (embedding a new file) comes and goes; a still waits it out.
    await this.page.waitForFunction(() => !document.querySelector('.map-activity, .pf-spin'), null, { timeout: 15_000 });
    // No machine paths on a landing page: the project shows as acme-signup and its files as project paths.
    const leak = await this.page.evaluate(() => /\/private\/|\/var\/folders|\/Users\/|coderay-demo|\/tmp\//.exec(document.body.innerText)?.[0] ?? null);
    if (leak) throw new Error(`${name}.png would show a machine path (${leak})`);
    await this.page.evaluate(() => document.fonts.ready);
    await settle(this.page);
    const path = join(SHOTS, `${name}.png`);
    await this.page.screenshot({ path });
    console.log(`  shot ${name}.png${this.zoom ? ` (map at ${Math.round(this.zoom * 100)} %)` : ''}`);
    this.zoom = null;
  }

  async chapter(title) {
    if (!this.video) return;
    this.chapters.push({ at: Date.now() / 1000, title });
    await this.page.evaluate((text) => window.__demo.title(text), title);
  }

  // Reading time in the video; nothing in the shots.
  async pause(ms) {
    if (this.video) await wait(ms);
  }

  fast(factor = 3) {
    if (!this.video) return;
    this.fastSince = { at: Date.now() / 1000, factor };
  }

  normal() {
    if (!this.video || !this.fastSince) return;
    this.zones.push({ from: this.fastSince.at, to: Date.now() / 1000, factor: this.fastSince.factor });
    this.fastSince = null;
  }

  // A wait the video leaves out entirely, such as a map being built.
  cut() {
    this.fast(Infinity);
  }

  // The agent panel, opened or closed with its status bar button, as a user would.
  async agentPanel(open) {
    const toggle = this.page.getByRole('button', { name: 'Agent and details' });
    if ((await toggle.getAttribute('aria-pressed')) === String(open)) return;
    await this.click(toggle, { after: 200 });
    // Off the button again, so its tooltip does not stay up: to bare map under the step rail.
    await this.moveTo({ x: 150, y: 790 });
    await this.pause(250);
  }

  async moveTo({ x, y }) {
    if (this.video) await this.page.evaluate(([px, py]) => window.__demo.move(px, py, null), [x, y]);
    await this.page.mouse.move(x, y, { steps: 4 });
    this.at = { x, y };
  }

  async point(locator, { position, ms } = {}) {
    await locator.waitFor();
    const box = await locator.boundingBox();
    const x = box.x + (position?.x ?? box.width / 2);
    const y = box.y + (position?.y ?? box.height / 2);
    if (this.video) await this.page.evaluate(([px, py, d]) => window.__demo.move(px, py, d), [x, y, ms ?? null]);
    await this.page.mouse.move(x, y, { steps: 4 });
    this.at = { x, y };
    return { x, y };
  }

  async hover(locator, options) {
    await this.point(locator, options);
    await this.pause(options?.dwell ?? 500);
  }

  async click(locator, options = {}) {
    const { x, y } = await this.point(locator, options);
    if (this.video) {
      await wait(140);
      await this.page.evaluate(() => window.__demo.press());
    }
    await this.page.mouse.click(x, y);
    await this.pause(options.after ?? 250);
  }

  async type(text, { delay = 38 } = {}) {
    if (this.video) await this.page.keyboard.type(text, { delay });
    else await this.page.keyboard.insertText(text);
  }

  async press(key) {
    await this.page.keyboard.press(key);
    await this.pause(200);
  }
}

// The map of the project before anything happens; for the video this runs before the recording starts.
async function opening(d) {
  const { page } = d;
  await page.getByRole('tablist', { name: 'Map view' }).waitFor({ timeout: 60_000 });
  await page.getByText('core connected').waitFor();
  await page.evaluate(() => document.fonts.ready);
  // The still of the map alone: the agent panel folded away (⌘⌥B), then back.
  const agentPanel = () => page.keyboard.press('Control+Alt+KeyB');
  if (!d.video) await agentPanel();
  await page.getByRole('button', { name: 'Expand all' }).click();
  await page.getByRole('button', { name: 'Collapse all' }).waitFor();
  await frame(page, 'overview');
  await d.shot('map');
  if (!d.video) {
    await agentPanel();
    await page.getByPlaceholder(/Message the agent/).waitFor();
  }
}

async function story(d) {
  const { page } = d;
  const flowNode = (id) => page.getByTestId(`flow-node-${id}`);

  await d.chapter('Ask');
  await d.pause(1800);

  // Ask.
  const composer = page.getByPlaceholder(/Message the agent/);
  await d.click(composer);
  await d.type(PROMPT, { delay: 30 });
  await d.pause(400);
  await d.press('Enter');
  d.fast(3);

  // 2. The plan waits on the map.
  const panel = page.getByTestId('plan-panel');
  await panel.getByText('Plan v1 · waiting for you').waitFor({ timeout: 30_000 });
  await page.getByTestId('plan-flow').waitFor();
  d.normal();
  await d.chapter('See the plan');
  // The plan gets the whole width; the chat comes back once the plan is approved.
  await d.agentPanel(false);
  await d.frame('plan');
  await d.shot('plan');
  await d.pause(1200);
  await d.hover(page.getByTestId('flow-step-2'), { dwell: 900 });
  await d.hover(flowNode('rate-limiter'), { dwell: 1100 });

  // 3. Steer it on the map: a comment on the endpoint, a part after the service.
  await d.chapter('Steer it on the map');
  await d.hover(flowNode('users-route'), { dwell: 300 });
  await d.click(flowNode('users-route').getByRole('button', { name: 'Comment' }));
  await d.type(STEER_COMMENT);
  await d.pause(300);
  await d.press('Enter');
  await d.hover(flowNode('user-service'), { dwell: 300 });
  await d.click(flowNode('user-service').getByRole('button', { name: 'Add a part after this' }));
  await d.type(STEER_ADD);
  await d.pause(300);
  await d.press('Enter');
  await flowNode('~ask-1').waitFor();
  await d.press('Escape');
  await page.getByTestId('flow-details').waitFor({ state: 'detached' }).catch(() => {});
  await d.pause(700);
  await d.click(page.getByTestId('steer-changes'));
  await page.getByTestId('steer-draft').waitFor();
  await d.click(page.getByTestId('steer-draft').getByRole('button', { name: 'Message' }));
  await page.getByTestId('steer-message').waitFor();
  await d.frame('plan');
  await d.shot('plan-steer');
  await d.pause(900);
  await d.hover(page.getByTestId('steer-send'), { dwell: 0 });
  d.mark('poster');
  await d.pause(1500);
  await d.click(page.getByTestId('steer-send'), { after: 150 });
  d.cut();

  // 4. The agent comes back with plan v2: the requested part is real now.
  await panel.getByText('Plan v2 · waiting for you').waitFor({ state: 'attached', timeout: 30_000 });
  await flowNode('audit-log').waitFor();
  await d.frame('plan');
  d.normal();
  await d.chapter('Approve');
  await d.agentPanel(false);
  await d.pause(900);
  await d.hover(flowNode('audit-log'), { dwell: 1200 });
  await d.click(page.getByTestId('steer-approve'), { after: 400 });

  // 5. Execution: steps go running → done on the map.
  await d.chapter('Watch it run');
  await d.agentPanel(true);
  await d.frame('plan');
  d.fast(2);
  await page.locator('[data-testid="flow-node-rate-limiter"][data-phase="active"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="plan-flow"]') && document.body.textContent.includes('tests/test_rate_limit.py'), null, { timeout: 30_000 });
  await d.frame('plan');
  await d.shot('execute');

  // 6. The agent reaches outside the plan: the write waits for the user.
  const gate = page.getByTestId('gate-card');
  await gate.waitFor({ timeout: 60_000 });
  d.normal();
  await d.chapter('Catch the strays');
  await gate.scrollIntoViewIfNeeded();
  await d.frame('plan');
  await d.shot('guard');
  await d.pause(2600);
  await d.click(gate.getByRole('button', { name: 'Allow once' }), { after: 500 });
  d.fast(2.5);
  await page.getByText('9 tests pass').waitFor({ timeout: 60_000 });
  await wait(800);
  d.normal();
  await d.pause(1200);

  // 7. Review: what was really done, on the same kind of map.
  await d.chapter('Review on the map');
  await d.click(page.getByRole('tab', { name: /^Review/ }));
  await d.click(page.getByRole('button', { name: 'Start review' }));
  await page.getByTestId('review-mode').waitFor();
  await d.pause(500);
  await d.click(page.getByRole('group', { name: 'Review view' }).getByRole('button', { name: 'Map' }), { after: 120 });
  // The core builds the review's map on request; the video skips the wait and opens on the finished, framed map.
  d.cut();
  const map = page.getByTestId('review-map');
  await map.waitFor();
  await page.getByTestId('review-map-part-email').waitFor({ timeout: 30_000 });
  // The list opens on the first file, which selects its part; Esc clears it, so the whole map shows.
  if (await page.getByTestId('review-map-details').isVisible()) await d.press('Escape');
  await d.frame('review');
  d.normal();
  await d.pause(1200);
  await d.hover(page.getByTestId('review-map-part-email'), { dwell: 1200 });
  const link = await linkBetween(page, 'user-service', 'rate-limit');
  await d.hover(link, { dwell: 1200 });

  // 8. Ask why: one question on a link, one on a part, sent together.
  await d.chapter('Ask why');
  await d.click(link);
  await d.press('q');
  await d.type(ASK_LINK);
  await d.press('Enter');
  await d.click(page.getByTestId('review-map-part-rate-limit'), { position: { x: 60, y: 14 } });
  await d.press('q');
  await d.type(ASK_PART);
  await d.press('Enter');
  await d.pause(700);
  await d.click(page.getByTestId('review-map-send'));
  d.fast(2);
  await page.getByText('20 sign-ups a minute').waitFor({ timeout: 30_000 });
  d.normal();
  const details = page.getByTestId('review-map-details');
  if (await details.isVisible()) await d.click(details.getByRole('button', { name: 'Close' }));
  await d.frame('review');
  await d.shot('review-map');
  await d.pause(2600);

  // The part's diff, grouped by the plan steps that made it, with their why.
  await d.click(page.getByTestId('review-map-part-user-service'), { position: { x: 60, y: 14 } });
  await d.pause(600);
  await d.click(page.getByRole('group', { name: 'Review view' }).getByRole('button', { name: 'Diff' }));
  await page.getByText('Why', { exact: true }).first().waitFor();
  await page.getByText('Being written…').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
  await quiet(page, '.rv-why');
  await d.shot('review-diff');
  await d.pause(3200);
}

async function launch(mode) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  });
  await context.addInitScript((prefs) => {
    for (const [key, value] of Object.entries(prefs)) localStorage.setItem(key, value);
  }, PREFS);
  if (mode === 'video') await context.addInitScript(installOverlay);
  const page = await context.newPage();
  return { browser, page };
}

async function runShots() {
  console.log('shots');
  mkdirSync(SHOTS, { recursive: true });
  const core = await startCore(buildScenario());
  const { browser, page } = await launch('shots');
  try {
    await page.goto(core.url);
    const d = new Director(page, 'shots');
    await opening(d);
    await story(d);
  } catch (error) {
    if (process.env.CAPTURE_DEBUG) await page.screenshot({ path: process.env.CAPTURE_DEBUG });
    throw error;
  } finally {
    await browser.close();
    await core.stop();
  }
}

// Frames come from the compositor (CDP screencast), so the clip is as sharp as the page; only changed frames arrive.
async function record(page, dir) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ at: metadata.timestamp, file });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: VIDEO_SIZE.width, maxHeight: VIDEO_SIZE.height, everyNthFrame: 1 });
  return {
    frames,
    stop: async () => {
      await cdp.send('Page.stopScreencast').catch(() => {});
    },
  };
}

// Wall-clock seconds to video seconds: fast zones run `factor` times quicker, cuts (factor Infinity) vanish.
// Zones may overlap; where they do, the quickest wins.
function timeMap(zones) {
  const points = [...new Set(zones.flatMap((zone) => [zone.from, zone.to]))].sort((a, b) => a - b);
  const pieces = points.slice(1).map((to, i) => {
    const from = points[i];
    const mid = (from + to) / 2;
    const factors = zones.filter((zone) => zone.from <= mid && mid <= zone.to).map((zone) => zone.factor);
    return { from, to, factor: factors.length > 0 ? Math.max(...factors) : 1 };
  });
  return (t) => pieces.reduce((out, p) => out - Math.max(0, Math.min(t, p.to) - p.from) * (1 - 1 / p.factor), t);
}

// Moments something reads as loading (sampled ten times a second in the page) become cuts.
function loaderCuts(samples) {
  const cuts = [];
  for (const { at } of [...samples].sort((a, b) => a.at - b.at)) {
    const last = cuts.at(-1);
    if (last && at - last.to <= 0.3) last.to = at + 0.15;
    else cuts.push({ from: at - 0.15, to: at + 0.15, factor: Infinity });
  }
  return cuts;
}

function ffmpeg(...argv) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: 'inherit' });
}

async function runVideo() {
  console.log('video');
  mkdirSync(VIDEO, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'coderay-video-'));
  const core = await startCore(buildScenario());
  const { browser, page } = await launch('video');
  const d = new Director(page, 'video');
  let recording;
  let end;
  let loaders = [];
  try {
    await page.goto(core.url);
    await opening(d);
    await wait(800);
    recording = await record(page, work);
    await page.evaluate(() => window.__demo.show(true));
    d.start = Date.now() / 1000;
    await story(d);
    end = Date.now() / 1000;
    await recording.stop();
    loaders = await page.evaluate(() => window.__demo.loaders);
  } finally {
    await browser.close();
    await core.stop();
  }

  // A constant 30 fps sequence: each output frame is the last captured frame at or before its (sped-up) time.
  const cuts = loaderCuts(loaders.filter((l) => l.at >= d.start && l.at <= end));
  if (cuts.length > 0) console.log(`  cut ${cuts.length} loading moments: ${[...new Set(loaders.filter((l) => l.at >= d.start && l.at <= end).map((l) => l.what))].join(', ')}`);
  const map = timeMap([...d.zones, ...cuts]);
  const t0 = map(d.start);
  const total = map(end) - t0;
  const frames = recording.frames.map((frame) => ({ ...frame, t: map(frame.at) - t0 }));
  const seq = join(work, 'seq');
  mkdirSync(seq);
  let j = 0;
  const count = Math.round(total * FPS);
  for (let k = 0; k < count; k += 1) {
    while (j + 1 < frames.length && frames[j + 1].t <= k / FPS) j += 1;
    symlinkSync(frames[j].file, join(seq, `${String(k).padStart(6, '0')}.jpg`));
  }
  const at = (wall) => Math.max(0, Math.round((map(wall) - t0) * 10) / 10);
  const chapters = d.chapters.map((chapter) => ({ t: at(chapter.at), title: chapter.title }));
  writeFileSync(join(VIDEO, 'chapters.json'), `${JSON.stringify(chapters, null, 2)}\n`);

  // Screencast JPEGs are full-range RGB; the clip is limited-range BT.709, tagged so browsers show the UI's own colours.
  const input = ['-framerate', String(FPS), '-i', join(seq, '%06d.jpg')];
  const vf = ['-vf', `format=rgb24,scale=${VIDEO_SIZE.width}:${VIDEO_SIZE.height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`];
  const tags = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
  const mp4 = join(VIDEO, 'demo.mp4');
  const webm = join(VIDEO, 'demo.webm');
  ffmpeg(...input, ...vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-tune', 'stillimage', '-profile:v', 'high', '-pix_fmt', 'yuv420p', ...tags, '-movflags', '+faststart', '-an', mp4);
  ffmpeg(...input, ...vf, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '33', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', ...tags, '-an', webm);
  const poster = Math.min(count - 1, Math.round(at(d.marks.poster) * FPS) + 6);
  ffmpeg('-i', join(seq, `${String(poster).padStart(6, '0')}.jpg`), '-vf', `scale=${VIDEO_SIZE.width}:${VIDEO_SIZE.height}`, '-q:v', '3', join(VIDEO, 'demo-poster.jpg'));
  rmSync(work, { recursive: true, force: true });
  const mb = (file) => (statSync(file).size / 1e6).toFixed(2);
  console.log(`  demo.mp4 ${mb(mp4)} MB, demo.webm ${mb(webm)} MB, ${total.toFixed(1)} s, ${recording.frames.length} captured frames`);
  console.log(`  chapters ${chapters.map((c) => `${c.t}s ${c.title}`).join(' · ')}`);
}

if (wantShots) await runShots();
if (wantVideo) await runVideo();
