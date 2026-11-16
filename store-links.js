/* ── STORE LINKS ──
 * On phones, open the native store app instead of the store's web page.
 *   data-store="play"        Google Play badge     → Play Store app on Android
 *   data-store="testflight"  TestFlight badge      → TestFlight app on iOS
 *   data-store="auto"        generic download CTA  → whichever store fits the device
 * Anywhere else (desktop, the "other" phone OS) the link's href is followed as usual.
 */
(() => {
  const PLAY_ID = 'com.meetfleet.mobile';
  const PLAY_WEB = `https://play.google.com/store/apps/details?id=${PLAY_ID}`;
  const PLAY_APP = `intent://details?id=${PLAY_ID}#Intent;scheme=market;package=com.android.vending;` +
    `S.browser_fallback_url=${encodeURIComponent(PLAY_WEB)};end`;

  const TESTFLIGHT_PATH = 'testflight.apple.com/join/nXyfPMSc';
  const TESTFLIGHT_WEB = `https://${TESTFLIGHT_PATH}`;
  const TESTFLIGHT_APP = `itms-beta://${TESTFLIGHT_PATH}`;

  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  // iPadOS Safari reports itself as a Mac, so also check for touch support.
  const isIOS = /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // A custom scheme fails silently when its app isn't installed, so if the page
  // is still in front shortly after, send the visitor to the web page instead.
  function openApp(appUrl, webUrl) {
    let left = false;
    const markLeft = () => { left = true; };
    document.addEventListener('visibilitychange', markLeft, { once: true });
    window.addEventListener('pagehide', markLeft, { once: true });
    window.addEventListener('blur', markLeft, { once: true });

    setTimeout(() => {
      document.removeEventListener('visibilitychange', markLeft);
      window.removeEventListener('pagehide', markLeft);
      window.removeEventListener('blur', markLeft);
      if (!left && document.visibilityState === 'visible') window.location.href = webUrl;
    }, 1500);

    window.location.href = appUrl;
  }

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-store]');
    if (!link) return;
    const store = link.dataset.store;

    if (isAndroid && (store === 'play' || store === 'auto')) {
      e.preventDefault();
      openApp(PLAY_APP, PLAY_WEB);
    } else if (isIOS && (store === 'testflight' || store === 'auto')) {
      e.preventDefault();
      openApp(TESTFLIGHT_APP, TESTFLIGHT_WEB);
    }
  });
})();
