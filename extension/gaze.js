(function () {
  const IN = "voice-pr-gaze-command";
  const OUT = "voice-pr-gaze";
  const statusEl = document.getElementById("vp-gaze-status");
  let started = false;

  function send(kind, detail = {}) {
    parent.postMessage({ type: OUT, kind, ...detail }, "*");
  }

  function status(message) {
    statusEl.textContent = message;
    send("status", { message });
  }

  function configureWebGazer() {
    if (!window.webgazer) throw new Error("WebGazer failed to load from extension package");
    window.webgazer.setGazeListener((data) => {
      if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
      send("prediction", { x: data.x, y: data.y });
    });
    window.webgazer.showVideoPreview?.(true);
    window.webgazer.showFaceOverlay?.(true);
    window.webgazer.showFaceFeedbackBox?.(true);
    window.webgazer.showPredictionPoints?.(true);
  }

  async function start() {
    try {
      if (started) return send("started");
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("camera API is unavailable in this browser");
      }
      status("starting extension-origin WebGazer");
      configureWebGazer();
      await window.webgazer.begin();
      started = true;
      document.body.classList.add("vp-gaze-active");
      send("started");
    } catch (e) {
      send("error", { message: String(e?.message || e) });
    }
  }

  function stop() {
    started = false;
    document.body.classList.remove("vp-gaze-active");
    statusEl.textContent = "Gaze tracker paused";
    try {
      if (window.webgazer?.end) window.webgazer.end();
      else window.webgazer?.pause?.();
    } catch {}
  }

  function calibrate(x, y) {
    if (!started || !Number.isFinite(x) || !Number.isFinite(y)) return;
    try {
      window.webgazer?.recordScreenPosition?.(x, y, "click");
    } catch {}
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.type !== IN) return;
    if (event.data.command === "start") start();
    if (event.data.command === "stop") stop();
    if (event.data.command === "calibrate") calibrate(event.data.x, event.data.y);
  });

  send("ready");
})();
