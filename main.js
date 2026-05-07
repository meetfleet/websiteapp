lucide.createIcons();

const vibrate = (pattern) => navigator?.vibrate?.(pattern);

document.querySelectorAll('[data-haptic]').forEach(el => {
  el.addEventListener('pointerdown', () => {
    vibrate(el.dataset.haptic === 'heavy' ? [10, 40, 10] : [8]);
  });
});
