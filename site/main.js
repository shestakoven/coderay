(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });

  /* ---------- the tour: a sticky stage driven by scroll ---------- */

  const tour = $('.tour');
  const steps = $$('.tour-steps > li');
  const wide = matchMedia('(min-width: 901px)');

  const stageViews = $('.stage-views');
  const stageTag = $('#stage-tag');
  const stageTicks = $('#stage-ticks');
  const stageText = $('#stage-text');
  let built = false;
  let active = -1;

  function buildStage() {
    if (built) return;
    built = true;
    steps.forEach((step, index) => {
      const shot = step.dataset.shot;
      const picture = document.createElement('picture');
      picture.innerHTML = `<source srcset="assets/shots/${shot}.webp" type="image/webp"><img src="assets/shots/${shot}.png" width="2880" height="1800" alt="" decoding="async"${index > 1 ? ' loading="lazy"' : ''}>`;
      stageViews.append(picture);

      const tick = document.createElement('button');
      tick.type = 'button';
      tick.style.setProperty('--c', step.dataset.color);
      tick.setAttribute('aria-label', step.dataset.name);
      tick.addEventListener('click', () => goTo(index));
      stageTicks.append(tick);
    });
  }

  function setActive(index) {
    if (index === active) return;
    const first = active === -1;
    active = index;
    const step = steps[index];
    $$('picture', stageViews).forEach((picture, i) => picture.classList.toggle('on', i === index));
    $$('button', stageTicks).forEach((tick, i) => {
      tick.classList.toggle('on', i === index);
      tick.classList.toggle('past', i < index);
    });
    stageTag.textContent = step.dataset.name;
    stageTag.style.setProperty('--c', step.dataset.color);
    stageText.innerHTML = $('.copy', step).innerHTML;
    stageText.classList.remove('in');
    if (!first && !reduceMotion) {
      void stageText.offsetWidth;
      stageText.classList.add('in');
    }
  }

  const STICKY_TOP = 72;
  const track = $('.tour-track');
  const stage = $('.tour-stage');

  function geometry() {
    const rect = track.getBoundingClientRect();
    const range = Math.max(1, rect.height - stage.offsetHeight - 0);
    return { rect, range, scrolled: STICKY_TOP - rect.top };
  }

  function update() {
    if (!tour.classList.contains('is-tour')) return;
    const { range, scrolled } = geometry();
    const p = Math.min(0.9999, Math.max(0, scrolled / range));
    setActive(Math.floor(p * steps.length));
  }

  function goTo(index) {
    const { rect, range } = geometry();
    const top = window.scrollY + rect.top - STICKY_TOP + ((index + 0.5) / steps.length) * range;
    window.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function syncTour() {
    const enhanced = wide.matches;
    tour.classList.toggle('is-tour', enhanced);
    if (enhanced) {
      buildStage();
      active = -1;
      update();
    }
  }
  wide.addEventListener('change', syncTour);
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update, { passive: true });
  syncTour();

  /* ---------- enlarge a screenshot ---------- */

  const zoom = document.createElement('dialog');
  zoom.className = 'zoom';
  zoom.setAttribute('aria-label', 'Enlarged screenshot');
  zoom.innerHTML = '<button class="close" type="button" aria-label="Close"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 2l10 10M12 2 2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button><img alt="">';
  document.body.append(zoom);
  const zoomImg = $('img', zoom);
  const openZoom = (src, alt) => {
    zoomImg.src = src;
    zoomImg.alt = alt || '';
    zoom.showModal();
  };
  zoom.addEventListener('click', () => zoom.close());
  $$('.tour-steps img').forEach((img) => {
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', img.alt + ' Enlarge.');
    img.addEventListener('click', () => openZoom(img.currentSrc || img.src, img.alt));
    img.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openZoom(img.currentSrc || img.src, img.alt);
      }
    });
  });
  stageViews.addEventListener('click', () => {
    const img = $$('picture', stageViews)[active]?.querySelector('img');
    if (img) openZoom(img.currentSrc || img.src, steps[active].dataset.name);
  });

  /* ---------- plan and review schematic ---------- */

  const sch = $('#sch');
  const state = $('#scheme-state');
  const segPlan = $('#seg-plan');
  const segReview = $('#seg-review');
  const TEXT = {
    plan: 'Three steps, six parts, two new links. Nothing is written until you approve.',
    review: 'Two steps done, one skipped. One link nobody planned, one planned link that never appeared.',
  };
  let touched = false;

  function setView(view) {
    sch.dataset.view = view;
    segPlan.setAttribute('aria-pressed', String(view === 'plan'));
    segReview.setAttribute('aria-pressed', String(view === 'review'));
    state.textContent = TEXT[view];
  }
  segPlan.addEventListener('click', () => { touched = true; setView('plan'); });
  segReview.addEventListener('click', () => { touched = true; setView('review'); });

  if (!reduceMotion && 'IntersectionObserver' in window) {
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      setTimeout(() => { if (!touched) setView('review'); }, 3400);
    }, { threshold: 0.65 });
    seen.observe($('.canvas'));
  }

  /* ---------- GitHub stars ---------- */

  const ghLink = $('a[data-gh]');
  const slug = ghLink && new URL(ghLink.href).pathname.replace(/^\/|\/$/g, '');
  const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));
  const showStars = (n) => n > 0 && $$('[data-gh-count]').forEach((el) => {
    $('b', el).textContent = compact(n);
    el.hidden = false;
  });
  if (slug && slug.includes('/')) {
    const key = `gh-stars:${slug}`;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
    if (cached) showStars(cached.n);
    if (!cached || Date.now() - cached.t > 3600e3) {
      fetch(`https://api.github.com/repos/${slug}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((repo) => {
          if (!repo || typeof repo.stargazers_count !== 'number') return;
          showStars(repo.stargazers_count);
          try { localStorage.setItem(key, JSON.stringify({ n: repo.stargazers_count, t: Date.now() })); } catch {}
        })
        .catch(() => {});
    }
  }

  /* ---------- latest download ---------- */

  const downloads = $$('a[data-download]');
  if (downloads.length && slug && slug.includes('/')) {
    const key = `gh-release:${slug}`;
    const apply = ({ version, url }) => {
      downloads.forEach((link) => { link.href = url; });
      $$('[data-version]').forEach((el) => { el.textContent = version; });
    };
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
    if (cached) apply(cached);
    if (!cached || Date.now() - cached.t > 3600e3) {
      fetch(`https://api.github.com/repos/${slug}/releases/latest`)
        .then((response) => (response.ok ? response.json() : null))
        .then((release) => {
          const dmg = release && release.assets.find((asset) => asset.name.endsWith('.dmg'));
          if (!dmg) return;
          const latest = { version: release.tag_name.replace(/^v/, ''), url: dmg.browser_download_url, t: Date.now() };
          apply(latest);
          try { localStorage.setItem(key, JSON.stringify(latest)); } catch {}
        })
        .catch(() => {});
    }
  }

  /* ---------- demo video and chapters ---------- */

  const player = $('#player');
  const video = $('#video');
  const play = $('#play');
  const chaptersList = $('#chapters');
  let chapters = [];
  // The demo plays by itself, silently, while it is on screen; a pause by the visitor sticks.
  let userPaused = false;
  let autoPaused = false;

  const label = (text) => {
    $('b', play).textContent = text;
    play.setAttribute('aria-label', text);
  };
  const setPlaying = (playing) => {
    player.classList.toggle('started', playing);
    label(playing ? 'Pause the demo' : video.currentTime > 0 ? 'Resume the demo' : 'Play the demo');
  };
  video.muted = true;
  video.addEventListener('play', () => setPlaying(true));
  video.addEventListener('pause', () => { if (!autoPaused) setPlaying(false); });
  play.addEventListener('click', () => {
    if (video.paused) {
      userPaused = false;
      video.play().catch(() => {});
    } else {
      userPaused = true;
      video.pause();
    }
  });

  if (!reduceMotion && 'IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (visible && video.paused && !userPaused) {
        autoPaused = false;
        video.play().catch(() => {});
      } else if (!visible && !video.paused) {
        autoPaused = true;
        video.pause();
      }
    }, { threshold: 0.4 }).observe($('.player .frame'));
  }

  const format = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

  fetch('assets/video/chapters.json')
    .then((response) => (response.ok ? response.json() : []))
    .catch(() => [])
    .then((list) => {
      chapters = list;
      if (!chapters.length) {
        chaptersList.hidden = true;
        return;
      }
      chapters.forEach((chapter) => {
        const item = document.createElement('li');
        item.innerHTML = '<button type="button"></button>';
        const button = $('button', item);
        button.textContent = chapter.title;
        button.title = `${chapter.title}, ${format(chapter.t)}`;
        button.addEventListener('click', () => {
          userPaused = false;
          video.currentTime = chapter.t;
          video.play().catch(() => {});
        });
        chaptersList.append(item);
      });
    });

  video.addEventListener('timeupdate', () => {
    let current = -1;
    chapters.forEach((chapter, index) => { if (video.currentTime >= chapter.t) current = index; });
    $$('button', chaptersList).forEach((button, index) => {
      button.classList.toggle('on', index === current);
      const end = chapters[index + 1] ? chapters[index + 1].t : video.duration;
      const progress = index === current ? (video.currentTime - chapters[index].t) / (end - chapters[index].t) : 0;
      button.style.setProperty('--p', String(Math.max(0, Math.min(1, progress || 0))));
    });
  });
})();
