// wakelock.js - keeps the tablet screen from sleeping while the app is open.
// Requires a secure context (HTTPS or localhost). Falls back silently if unsupported.

const WakeLockManager = (() => {
  let sentinel = null;
  let supported = "wakeLock" in navigator;
  let statusListeners = [];

  function notify(status) {
    statusListeners.forEach((fn) => fn(status));
  }

  async function request() {
    if (!supported) {
      notify("unsupported");
      return false;
    }
    try {
      sentinel = await navigator.wakeLock.request("screen");
      notify("active");
      sentinel.addEventListener("release", () => {
        notify("released");
      });
      return true;
    } catch (err) {
      // Common reasons: insecure context, low battery, permission denied.
      console.warn("Wake Lock request failed:", err);
      notify("failed");
      return false;
    }
  }

  function release() {
    if (sentinel) {
      sentinel.release().catch(() => {});
      sentinel = null;
    }
  }

  function onStatusChange(fn) {
    statusListeners.push(fn);
  }

  function init() {
    request();
    // Re-acquire the lock whenever the tab/app becomes visible again
    // (the OS auto-releases it when the screen is hidden/backgrounded).
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") {
        await request();
      }
    });
  }

  return { init, request, release, onStatusChange, isSupported: () => supported };
})();
