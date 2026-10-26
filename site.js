/**
 * Academia Ejemplo — landing.
 * Entradas por sección, fila de pasos con progreso y la carátula en vivo.
 */
(function () {
  'use strict';

  const root = document.documentElement;
  root.classList.add('js');

  // Entradas: cada parte de una sección aparece una vez, escalonada.
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
  // Red de seguridad: nada queda oculto si el observador no dispara.
  setTimeout(() => targets.forEach((el) => el.classList.add('is-in')), 1500);

  // Índice fijo de servicios: marca la etapa que está a la vista.
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

  // Fila de pasos: botones, barra de progreso y avance automático.
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

    // Avance automático: pasa un momento cada pocos segundos y vuelve al inicio al llegar al final.
    // Se detiene con el cursor o el foco encima, con la pestaña oculta, fuera de pantalla,
    // si la persona prefiere menos movimiento, o con el botón de pausa.
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
        toggle.setAttribute('aria-label', paused ? 'Reanudar el movimiento automático' : 'Pausar el movimiento automático');
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

  // Fotos editables desde el panel admin: cada <img data-slot> cambia por la que se subió.
  // La última lista se guarda en el navegador para que la siguiente visita no parpadee.
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
      img.alt = ''; // el texto alternativo original describía la foto anterior
    });
  };
  if (slotImages.length && window.APP_CONFIG && window.APP_CONFIG.SCRIPT_URL && !/^PEGAR_/.test(window.APP_CONFIG.SCRIPT_URL)) {
    try {
      const cached = JSON.parse(localStorage.getItem(IMAGES_KEY) || 'null');
      if (cached) applyImages(cached);
    } catch (err) {
      // Sin almacenamiento: se usa solo la respuesta del servidor.
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

  // La carátula en vivo.
  const coverForm = document.querySelector('.cover-controls');
  if (coverForm) coverForm.addEventListener('submit', (e) => e.preventDefault());
  const fields = {
    titulo: document.getElementById('c-titulo'),
    modalidad: document.getElementById('c-modalidad'),
    nivel: document.getElementById('c-nivel'),
    ciudad: document.getElementById('c-ciudad'),
  };
  const out = {
    titulo: document.getElementById('out-titulo'),
    modalidad: document.getElementById('out-modalidad'),
    nivel: document.getElementById('out-nivel'),
    ciudad: document.getElementById('out-ciudad'),
  };
  document.getElementById('out-anio').textContent = String(new Date().getFullYear());

  function renderCover() {
    out.titulo.textContent = fields.titulo.value.trim() || 'El título de tu trabajo';
    out.modalidad.textContent = fields.modalidad.value;
    out.nivel.textContent = fields.nivel.value;
    out.ciudad.textContent = fields.ciudad.value;
  }
  Object.values(fields).forEach((f) => f && f.addEventListener('input', renderCover));
  renderCover();
})();
