// Runs inside the page for the video only: a visible pointer (headless Chromium draws none) and the chapter titles.
// Serialized by addInitScript, so it must not use anything from this module's scope.
export function installOverlay() {
  const ready = () => {
    if (window.__demo || !document.body) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 2147483647; pointer-events: none;
        transform: translate(-100px, -100px); will-change: transform; filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); opacity: 0; transition: opacity .25s; }
      #demo-cursor.on { opacity: 1; }
      .demo-ring { position: fixed; z-index: 2147483646; pointer-events: none; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
        border: 2px solid rgba(147, 197, 253, .95); background: rgba(96, 165, 250, .18); animation: demo-ring .5s cubic-bezier(.2,.7,.3,1) forwards; }
      @keyframes demo-ring { from { transform: scale(.35); opacity: 1; } to { transform: scale(1.25); opacity: 0; } }
      #demo-title { position: fixed; top: 5px; left: 50%; z-index: 2147483645; pointer-events: none; transform: translateX(-50%);
        display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 16px 0 12px; border-radius: 15px;
        background: rgba(24, 25, 30, .92); border: 1px solid rgba(255,255,255,.10); box-shadow: 0 6px 24px rgba(0,0,0,.45);
        font: 600 15px/1 'IBM Plex Sans', system-ui, sans-serif; letter-spacing: -.005em; color: #f3f4f6; white-space: nowrap;
        opacity: 0; transition: opacity .35s ease; }
      #demo-title.on { opacity: 1; }
      #demo-title .n { font: 500 12px/1 'JetBrains Mono', ui-monospace, monospace; color: #8b93a7; }
      #demo-title .dot { width: 7px; height: 7px; border-radius: 50%; background: #4c8dff; box-shadow: 0 0 0 3px rgba(76,141,255,.18); }
      #demo-title .t { display: inline-block; transition: opacity .25s ease, transform .25s ease; }
      #demo-title .t.out { opacity: 0; transform: translateY(-4px); }
    `;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 1.8 L3 17.6 L7.2 13.7 L10 20.2 L12.9 19 L10.2 12.6 L16.1 12.6 Z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cursor);
    const title = document.createElement('div');
    title.id = 'demo-title';
    title.innerHTML = '<span class="dot"></span><span class="n"></span><span class="t"></span>';
    document.body.appendChild(title);

    // What reads as loading, sampled ten times a second, so the run can check the cut left none of it on screen.
    const loaders = [];
    const LOADING = ['Building the map', 'Being written', 'No overview yet', 'Updating the map', 'it is revising the plan'];
    setInterval(() => {
      const now = Date.now() / 1000;
      const spin = [...document.querySelectorAll('.pf-spin, .iv-loading, .map-activity')].some((el) => el.getBoundingClientRect().width > 0);
      if (spin) loaders.push({ at: now, what: 'spinner' });
      const text = document.body.innerText;
      for (const what of LOADING) if (text.includes(what)) loaders.push({ at: now, what });
    }, 100);

    let at = { x: 720, y: 520 };
    let frame = 0;
    let chapter = 0;
    const place = (p) => { cursor.style.transform = `translate(${p.x - 3}px, ${p.y - 2}px)`; };
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    window.__demo = {
      loaders,
      show(on) {
        cursor.classList.toggle('on', on);
        place(at);
      },
      move(x, y, ms) {
        const from = { ...at };
        const distance = Math.hypot(x - from.x, y - from.y);
        const duration = ms ?? Math.min(900, Math.max(260, 180 + distance * 0.75));
        // A slight arc, as a hand moves.
        const bend = { x: (from.x + x) / 2 + (y - from.y) * 0.08, y: (from.y + y) / 2 - (x - from.x) * 0.08 };
        cancelAnimationFrame(frame);
        return new Promise((done) => {
          const start = performance.now();
          const step = (now) => {
            const t = Math.min(1, (now - start) / duration);
            const k = ease(t);
            const u = 1 - k;
            at = { x: u * u * from.x + 2 * u * k * bend.x + k * k * x, y: u * u * from.y + 2 * u * k * bend.y + k * k * y };
            place(at);
            if (t < 1) frame = requestAnimationFrame(step);
            else done();
          };
          frame = requestAnimationFrame(step);
        });
      },
      press() {
        const ring = document.createElement('div');
        ring.className = 'demo-ring';
        ring.style.left = `${at.x}px`;
        ring.style.top = `${at.y}px`;
        document.body.appendChild(ring);
        setTimeout(() => ring.remove(), 600);
      },
      title(text) {
        chapter += 1;
        const label = title.querySelector('.t');
        const n = title.querySelector('.n');
        const apply = () => {
          label.textContent = text;
          n.textContent = String(chapter).padStart(2, '0');
          label.classList.remove('out');
        };
        if (title.classList.contains('on')) {
          label.classList.add('out');
          setTimeout(apply, 220);
        } else {
          apply();
          title.classList.add('on');
        }
      },
    };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
}
