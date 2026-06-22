const vibrate = (pattern) => navigator?.vibrate?.(pattern);

document.querySelectorAll('[data-haptic]').forEach(el => {
  el.addEventListener('pointerdown', () => {
    vibrate(el.dataset.haptic === 'heavy' ? [10, 40, 10] : [8]);
  });
});

/* ── SCENE SLIDER ── */
(() => {
  const bgSlides = document.querySelectorAll('.bg-slide');
  const heroSlides = document.querySelectorAll('.hero-text-slide');
  const activityTracks = document.querySelectorAll('.activity-track');
  
  if (!bgSlides.length || !heroSlides.length || !activityTracks.length) return;

  let currentScene = 0;
  const numScenes = bgSlides.length;

  setInterval(() => {
    // Remove active
    bgSlides[currentScene].classList.remove('active');
    heroSlides[currentScene].classList.remove('active');
    activityTracks[currentScene].classList.remove('active');

    // Next scene
    currentScene = (currentScene + 1) % numScenes;

    // Add active
    bgSlides[currentScene].classList.add('active');
    heroSlides[currentScene].classList.add('active');
    activityTracks[currentScene].classList.add('active');
  }, 7000);
})();

/* ── CUSTOM CURSOR — activity card only ── */
(() => {
  const zones = document.querySelectorAll('.activity-main');
  
  zones.forEach(zone => {
    const cursor = zone.querySelector('.card-cursor');
    if (!cursor) return;

    let mouseX = 0, mouseY = 0;
    let curX = 0, curY = 0;
    let isInside = false;
    let rafId = null;

    const LERP = 0.12;

    function lerp(a, b, t) {
      return a + (b - a) * t;
    }

    function tick() {
      curX = lerp(curX, mouseX, LERP);
      curY = lerp(curY, mouseY, LERP);

      cursor.style.left = curX + 'px';
      cursor.style.top  = curY + 'px';

      rafId = requestAnimationFrame(tick);
    }

    zone.addEventListener('mouseenter', (e) => {
      const rect = zone.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
      
      curX = mouseX;
      curY = mouseY;
      cursor.style.left = curX + 'px';
      cursor.style.top  = curY + 'px';

      isInside = true;
      cursor.classList.add('is-visible');

      if (!rafId) rafId = requestAnimationFrame(tick);
    });

    zone.addEventListener('mousemove', (e) => {
      const rect = zone.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
    });

    zone.addEventListener('mouseleave', () => {
      isInside = false;
      cursor.classList.remove('is-visible');

      setTimeout(() => {
        if (!isInside && rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      }, 500);
    });
  });
})();
