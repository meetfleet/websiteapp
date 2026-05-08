lucide.createIcons();

const vibrate = (pattern) => navigator?.vibrate?.(pattern);

document.querySelectorAll('[data-haptic]').forEach(el => {
  el.addEventListener('pointerdown', () => {
    vibrate(el.dataset.haptic === 'heavy' ? [10, 40, 10] : [8]);
  });
});

/* ── CUSTOM CURSOR — activity card only ── */
(() => {
  const zone = document.getElementById('activityMain');
  const cursor = document.getElementById('cardCursor');
  if (!zone || !cursor) return;

  // State
  let mouseX = 0, mouseY = 0;   // actual mouse position (relative to zone)
  let curX = 0, curY = 0;       // interpolated cursor position
  let isInside = false;
  let rafId = null;

  const LERP = 0.12; // smoothing factor — lower = more lag

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
    // Snap interpolated position on first entry to avoid sliding from corner
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

    // Let the animation loop run a bit longer so it can finish the fade-out,
    // then stop it to save resources.
    setTimeout(() => {
      if (!isInside && rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }, 500);
  });
})();
