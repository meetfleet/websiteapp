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

  const numScenes = Math.min(bgSlides.length, heroSlides.length, activityTracks.length);
  let currentScene = 0;
  let autoPlayTimer = null;

  const trackWidth = 365; // 345 width + 20 gap

  function updateCarousel(dragOffset = 0, withTransition = true) {
    activityTracks.forEach((track, i) => {
      let d = i - currentScene;
      
      // Wrap around logic for 6 cards
      if (d < -2) d += numScenes;
      if (d > 3) d -= numScenes;

      const x = d * trackWidth + dragOffset;
      
      track.style.transition = withTransition ? 'transform 0.8s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.8s ease' : 'none';
      
      if (d === 0) {
        track.style.transform = `translateX(${x}px) scale(1)`;
        track.style.opacity = 1;
        track.style.pointerEvents = 'auto';
        track.style.zIndex = 10;
        const glass = track.querySelector('.glass-card');
        if (glass) glass.style.borderRadius = '28px';
      } else {
        track.style.transform = `translateX(${x}px) scale(0.95)`;
        track.style.opacity = Math.abs(x) > trackWidth * 1.5 ? 0 : 0.6; 
        track.style.pointerEvents = 'none';
        track.style.zIndex = 1;
        const glass = track.querySelector('.glass-card');
        if (glass) glass.style.borderRadius = '40px';
      }
    });
  }

  // Initialize initial positions
  updateCarousel(0, false);

  function goToScene(targetScene) {
    if (targetScene === currentScene) return;

    if (targetScene < 0) targetScene = numScenes - 1;
    if (targetScene >= numScenes) targetScene = 0;

    const prevScene = currentScene;
    currentScene = targetScene;

    bgSlides[prevScene].classList.remove('active');
    heroSlides[prevScene].classList.remove('active');
    
    bgSlides[currentScene].classList.add('active');
    heroSlides[currentScene].classList.add('active');

    updateCarousel(0, true);

    // Floating action buttons
    if (currentScene !== 0) {
      document.body.classList.add('hide-floats');
    } else {
      document.body.classList.remove('hide-floats');
    }

    // Mobile specific classes
    document.body.classList.remove('scene-ride', 'scene-light');
    if (currentScene === 1) {
      document.body.classList.add('scene-ride');
    } else if (currentScene >= 2 && currentScene <= 4) {
      document.body.classList.add('scene-light');
    }
  }

  function startAutoPlay() {
    if (autoPlayTimer) clearInterval(autoPlayTimer);
    autoPlayTimer = setInterval(() => {
      goToScene(currentScene + 1);
    }, 7000);
  }

  startAutoPlay();

  /* ── SWIPE LOGIC ── */
  let startX = 0;
  let startY = 0;
  let isDragging = false;
  let currentOffset = 0;

  const sliderZone = document.querySelector('.activity-slider') || document.body;

  sliderZone.addEventListener('pointerdown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    clearInterval(autoPlayTimer);
    sliderZone.setPointerCapture(e.pointerId);
  });

  sliderZone.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const diffX = e.clientX - startX;
    const diffY = e.clientY - startY;

    if (Math.abs(diffX) > Math.abs(diffY)) {
      e.preventDefault(); // Prevent scrolling
      currentOffset = diffX;
      updateCarousel(currentOffset, false);
    }
  });

  sliderZone.addEventListener('pointerup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    sliderZone.releasePointerCapture(e.pointerId);

    if (currentOffset > 80) {
      goToScene(currentScene - 1);
    } else if (currentOffset < -80) {
      goToScene(currentScene + 1);
    } else {
      updateCarousel(0, true); // Snap back to center
    }
    
    currentOffset = 0;
    startAutoPlay();
  });

  sliderZone.addEventListener('pointercancel', (e) => {
    if (!isDragging) return;
    isDragging = false;
    sliderZone.releasePointerCapture(e.pointerId);
    updateCarousel(0, true);
    currentOffset = 0;
    startAutoPlay();
  });

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
