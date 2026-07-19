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

  function updateCarousel(dragOffset = 0, withTransition = true) {
    const trackWidth = window.innerWidth <= 768 ? 312 : 365; // 300 width + 12 gap vs 345 width + 20 gap

    activityTracks.forEach((track, i) => {
      let d = i - currentScene;
      
      // Wrap around logic for 6 cards
      if (d < -2) d += numScenes;
      if (d > 3) d -= numScenes;

      const x = d * trackWidth + dragOffset;
      
      track.style.transition = withTransition ? 'transform 0.8s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.8s ease, filter 0.8s ease' : 'none';
      
      if (d === 0) {
        track.style.transform = `translateX(${x}px) scale(1)`;
        track.style.opacity = 1;
        track.style.pointerEvents = 'auto';
        track.style.zIndex = 10;
        track.style.maskImage = 'none';
        track.style.webkitMaskImage = 'none';
        track.style.filter = 'blur(0px)';
        const glass = track.querySelector('.glass-card');
        if (glass) glass.style.borderRadius = '28px';
      } else {
        const isDesktop = window.innerWidth > 768;
        track.style.transform = `translateX(${x}px) scale(0.95)`;
        track.style.opacity = Math.abs(x) > trackWidth * 1.5 ? 0 : (isDesktop ? 0.35 : 0.6); 
        track.style.filter = isDesktop ? 'blur(4px)' : 'blur(0px)';
        track.style.pointerEvents = 'none';
        track.style.zIndex = 1;
        
        if (isDesktop) {
          if (d < 0) {
            track.style.maskImage = 'linear-gradient(to right, transparent 0%, transparent 20%, rgba(0,0,0,1) 80%)';
            track.style.webkitMaskImage = 'linear-gradient(to right, transparent 0%, transparent 20%, rgba(0,0,0,1) 80%)';
          } else if (d > 0) {
            track.style.maskImage = 'linear-gradient(to left, transparent 0%, transparent 20%, rgba(0,0,0,1) 80%)';
            track.style.webkitMaskImage = 'linear-gradient(to left, transparent 0%, transparent 20%, rgba(0,0,0,1) 80%)';
          }
        } else {
          track.style.maskImage = 'none';
          track.style.webkitMaskImage = 'none';
        }

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

  /* ── INNER CARD BOTTOM SWIPE LOGIC ── */
  const cardBottoms = document.querySelectorAll('.card-bottom');
  
  cardBottoms.forEach(bottom => {
    let innerStartX = 0;
    let isInnerDragging = false;
    let innerOffset = 0;
    
    // We can infer state from the presence of the class
    const isMessageShowing = () => bottom.classList.contains('show-message');

    bottom.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); // VERY IMPORTANT: Prevents main carousel from sliding!
      isInnerDragging = true;
      innerStartX = e.clientX;
      bottom.setPointerCapture(e.pointerId);
      
      // Temporarily disable CSS transitions during drag for instant finger tracking
      const orig = bottom.querySelector('.original-state');
      const msg = bottom.querySelector('.message-state');
      if (orig) orig.style.transition = 'none';
      if (msg) msg.style.transition = 'none';
    });
    
    bottom.addEventListener('pointermove', (e) => {
      if (!isInnerDragging) return;
      e.stopPropagation();
      e.preventDefault();
      
      innerOffset = e.clientX - innerStartX;
      
      const orig = bottom.querySelector('.original-state');
      const msg = bottom.querySelector('.message-state');
      
      // Calculate physical dragging math (slower, deliberate drag)
      const progress = Math.min(Math.max(innerOffset / 140, -1), 1); 
      const travelDist = progress * 40; // Clamped to max 40px travel distance for stability
      
      if (!isMessageShowing()) {
        // Dragging out of original state
        if (orig) {
          orig.style.transform = `translateX(${travelDist}px) scale(${1 - Math.abs(progress)*0.15})`;
          orig.style.opacity = 1 - Math.abs(progress);
        }
        if (msg) {
          const startX = innerOffset > 0 ? -40 : 40;
          msg.style.transform = `translateX(${startX * (1 - Math.abs(progress))}px) scale(${0.85 + Math.abs(progress)*0.15})`;
          msg.style.opacity = Math.abs(progress);
        }
      } else {
        // Dragging out of message state
        if (msg) {
          msg.style.transform = `translateX(${travelDist}px) scale(${1 - Math.abs(progress)*0.15})`;
          msg.style.opacity = 1 - Math.abs(progress);
        }
        if (orig) {
          const startX = innerOffset > 0 ? -40 : 40;
          orig.style.transform = `translateX(${startX * (1 - Math.abs(progress))}px) scale(${0.85 + Math.abs(progress)*0.15})`;
          orig.style.opacity = Math.abs(progress);
        }
      }
    });
    
    const resetInnerStyles = () => {
      const orig = bottom.querySelector('.original-state');
      const msg = bottom.querySelector('.message-state');
      
      if (orig) orig.style.transition = '';
      if (msg) msg.style.transition = '';
      
      // Force reflow to ensure CSS transitions re-activate before snapping styles
      bottom.offsetHeight;
      
      if (orig) {
        orig.style.transform = '';
        orig.style.opacity = '';
      }
      if (msg) {
        msg.style.transform = '';
        msg.style.opacity = '';
      }
    };
    
    bottom.addEventListener('pointerup', (e) => {
      if (!isInnerDragging) return;
      isInnerDragging = false;
      e.stopPropagation();
      bottom.releasePointerCapture(e.pointerId);
      
      resetInnerStyles(); // Let CSS take back control
      
      // Require a deliberate 50px drag to toggle state
      if (Math.abs(innerOffset) > 50) {
        bottom.classList.toggle('show-message');
      }
      innerOffset = 0;
    });

    bottom.addEventListener('pointercancel', (e) => {
      if (!isInnerDragging) return;
      isInnerDragging = false;
      e.stopPropagation();
      bottom.releasePointerCapture(e.pointerId);
      resetInnerStyles();
      innerOffset = 0;
    });
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
