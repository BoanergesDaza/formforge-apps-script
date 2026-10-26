/**
 * Example Academy - landing page.
 * Reveal animations, row of steps with progress and the live cover page.
 */
(function () {
  'use strict';

  const root = document.documentElement;
  root.classList.add('js');

  // Reveals: each part of a section appears once, staggered.
  const groups = [
    '[data-reveal]',
    '.sheet-text',
    '.cover',
  ];
  const targets = Array.from(document.querySelectorAll(groups.join(',')));
  targets.forEach(function (el) {
    const siblings = Array.from(el.parentElement.children).filter((c) => targets.indexOf(c) !== -1);
    el.style.setProperty('--d', Math.min(siblings.indexOf(el), 6) * 80 + 'ms');
  });
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    targets.forEach((el) => io.observe(el));
  } else {
    targets.forEach((el) => el.classList.add('is-in'));
  }
  // Safety net: nothing stays hidden if the observer never fires.
  setTimeout(() => targets.forEach((el) => el.classList.add('is-in')), 1500);

  // Sticky services index: highlights the stage that is in view.
  const indexLinks = Array.from(document.querySelectorAll('.services-index a'));
  if ('IntersectionObserver' in window && indexLinks.length) {
    const stageObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        indexLinks.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === '#' + entry.target.id));
      });
    }, { rootMargin: '-45% 0px -45% 0px' });
    document.querySelectorAll('.sheet').forEach((s) => stageObserver.observe(s));
  }

  // Row of steps: buttons, progress bar and automatic advance.
  const row = document.querySelector('.row');
  const bar = document.querySelector('.progress span');
  if (row && bar) {
    const stepSize = () => row.querySelector('.moment').offsetWidth + 32;
    const update = function () {
      const max = row.scrollWidth - row.clientWidth;
      const ratio = max > 0 ? row.scrollLeft / max : 1;
      bar.style.width = 20 + ratio * 80 + '%';
    };
    row.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
    document.querySelectorAll('[data-scroll]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        row.scrollBy({ left: Number(btn.dataset.scroll) * stepSize(), behavior: 'smooth' });
      });
    });

    // Automatic advance: moves one step every few seconds and returns to the start at the end.
    // It stops with the cursor or focus on it, with the tab hidden, off screen,
    // if the person prefers reduced motion, or with the pause button.
    const toggle = document.getElementById('steps-toggle');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const auto = { userPaused: reduce, hover: false, visible: false, timer: null };
    const tick = function () {
      const max = row.scrollWidth - row.clientWidth;
      if (row.scrollLeft >= max - 4) row.scrollTo({ left: 0, behavior: 'smooth' });
      else row.scrollBy({ left: stepSize(), behavior: 'smooth' });
    };
    const sync = function () {
      const run = !auto.userPaused && !auto.hover && auto.visible && !document.hidden;
      if (run && !auto.timer) auto.timer = setInterval(tick, 4500);
      if (!run && auto.timer) { clearInterval(auto.timer); auto.timer = null; }
    };
    const setPaused = function (paused) {
      auto.userPaused = paused;
      if (toggle) {
        toggle.classList.toggle('is-paused', paused);
        toggle.setAttribute('aria-pressed', String(paused));
        toggle.setAttribute('aria-label', paused ? 'Resume the automatic movement' : 'Pause the automatic movement');
      }
      sync();
    };
    if (toggle) toggle.addEventListener('click', () => setPaused(!auto.userPaused));
    row.addEventListener('mouseenter', () => { auto.hover = true; sync(); });
    row.addEventListener('mouseleave', () => { auto.hover = false; sync(); });
    row.addEventListener('focusin', () => { auto.hover = true; sync(); });
    row.addEventListener('focusout', () => { auto.hover = false; sync(); });
    row.addEventListener('touchstart', () => { auto.hover = true; sync(); }, { passive: true });
    row.addEventListener('touchend', () => { setTimeout(() => { auto.hover = false; sync(); }, 6000); }, { passive: true });
    document.addEventListener('visibilitychange', sync);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        auto.visible = entries[0].isIntersecting;
        sync();
      }, { threshold: 0.3 }).observe(row);
    }
    setPaused(auto.userPaused);
  }

  // Photos editable from the admin panel: each <img data-slot> is replaced by the uploaded one.
  // The latest list is kept in the browser so the next visit does not flicker.
  const IMAGES_KEY = 'form-images';
  const slotImages = Array.from(document.querySelectorAll('img[data-slot]'));
  const applyImages = function (map) {
    slotImages.forEach(function (img) {
      const url = map && map[img.dataset.slot];
      if (img.dataset.defaultSrc === undefined) img.dataset.defaultSrc = img.getAttribute('src');
      if (!url) {
        if (img.getAttribute('src') !== img.dataset.defaultSrc) img.src = img.dataset.defaultSrc;
        return;
      }
      if (img.getAttribute('src') === url) return;
      img.onerror = function () { img.onerror = null; img.src = img.dataset.defaultSrc; };
      img.src = url;
      img.alt = ''; // the original alt text described the previous photo
    });
  };
  if (slotImages.length && window.APP_CONFIG && window.APP_CONFIG.SCRIPT_URL && !/^PASTE_/.test(window.APP_CONFIG.SCRIPT_URL)) {
    try {
      const cached = JSON.parse(localStorage.getItem(IMAGES_KEY) || 'null');
      if (cached) applyImages(cached);
    } catch (err) {
      // No storage: only the server response is used.
    }
    fetch(window.APP_CONFIG.SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'getSiteImages' }),
    })
      .then((res) => res.json())
      .then(function (json) {
        if (!json || !json.ok) return;
        applyImages(json.data.images);
        try { localStorage.setItem(IMAGES_KEY, JSON.stringify(json.data.images)); } catch (err) { /* sin almacenamiento */ }
      })
      .catch(() => null);
  }

  // The live cover page.
  const coverForm = document.querySelector('.cover-controls');
  if (coverForm) coverForm.addEventListener('submit', (e) => e.preventDefault());
  const fields = {
    title: document.getElementById('c-title'),
    mode: document.getElementById('c-mode'),
    level: document.getElementById('c-level'),
    city: document.getElementById('c-city'),
  };
  const out = {
    title: document.getElementById('out-title'),
    mode: document.getElementById('out-mode'),
    level: document.getElementById('out-level'),
    city: document.getElementById('out-city'),
  };
  document.getElementById('out-year').textContent = String(new Date().getFullYear());

  function renderCover() {
    out.title.textContent = fields.title.value.trim() || 'The title of your work';
    out.mode.textContent = fields.mode.value;
    out.level.textContent = fields.level.value;
    out.city.textContent = fields.city.value;
  }
  Object.values(fields).forEach((f) => f && f.addEventListener('input', renderCover));
  renderCover();
})();
