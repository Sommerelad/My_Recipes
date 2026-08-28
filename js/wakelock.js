// wakelock.js - keeps the tablet screen from sleeping while the app is open.
// Requires a secure context (HTTPS or localhost). Falls back silently if unsupported.
// Can be turned on/off (the app persists that choice and passes the initial value in).

const WakeLockManager = (() => {
  let sentinel = null;
  let supported = "wakeLock" in navigator;
  let enabled = true;
  let statusListeners = [];

  function notify(status) {
    statusListeners.forEach((fn) => fn(status));
  }

  async function request() {
    if (!enabled) {
      notify("disabled");
      return false;
    }
    if (!supported) {
      notify("unsupported");
      return false;
    }
    try {
      sentinel = await navigator.wakeLock.request("screen");
      notify("active");
      sentinel.addEventListener("release", () => {
        // Only report "released" if we didn't just release it ourselves via setEnabled(false).
        if (enabled) notify("released");
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

  function setEnabled(value) {
    enabled = !!value;
    if (enabled) {
      request();
    } else {
      release();
      notify("disabled");
    }
  }

  function onStatusChange(fn) {
    statusListeners.push(fn);
  }

  function init(initialEnabled) {
    enabled = initialEnabled !== false;
    if (enabled) request();
    else notify("disabled");
    // Re-acquire the lock whenever the tab/app becomes visible again
    // (the OS auto-releases it when the screen is hidden/backgrounded).
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible" && enabled) {
        await request();
      }
    });
  }

  return {
    init,
    request,
    release,
    setEnabled,
    onStatusChange,
    isSupported: () => supported,
    isEnabled: () => enabled
  };
})();
