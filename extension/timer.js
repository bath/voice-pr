// Pure elapsed-time controller shared by the capture UI and unit tests.
(function (global) {
  function createElapsedTimer(options = {}) {
    const now = options.now || (() => Date.now());
    const schedule =
      options.setInterval || ((callback, ms) => setInterval(callback, ms));
    const cancel = options.clearInterval || ((id) => clearInterval(id));
    const onTick = options.onTick || (() => {});
    const intervalMs = options.intervalMs || 250;
    let startedAt = null;
    let elapsedMs = 0;
    let intervalId = null;

    const tick = () => {
      if (startedAt == null) return;
      elapsedMs = Math.max(0, now() - startedAt);
      onTick(elapsedMs, { running: true });
    };

    function start(at = now()) {
      if (intervalId != null) return elapsedMs;
      startedAt = Number.isFinite(at) ? at : now();
      tick();
      intervalId = schedule(tick, intervalMs);
      return elapsedMs;
    }

    function stop(authoritativeMs = null) {
      if (intervalId != null) cancel(intervalId);
      intervalId = null;
      if (Number.isFinite(authoritativeMs)) elapsedMs = Math.max(0, authoritativeMs);
      else if (startedAt != null) elapsedMs = Math.max(0, now() - startedAt);
      onTick(elapsedMs, { running: false });
      return elapsedMs;
    }

    function reset() {
      if (intervalId != null) cancel(intervalId);
      intervalId = null;
      startedAt = null;
      elapsedMs = 0;
    }

    return {
      start,
      stop,
      reset,
      elapsed: () => elapsedMs,
      running: () => intervalId != null,
    };
  }

  global.VoicePrTimer = { createElapsedTimer };
})(globalThis);
