const DEFAULT_BRIDGE_URL = "http://localhost:4100";
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);

const form = document.getElementById("options-form");
const input = document.getElementById("bridge-url");
const reset = document.getElementById("reset");
const status = document.getElementById("status");

function normalizeBridgeUrl(value) {
  const raw = String(value || DEFAULT_BRIDGE_URL).trim();
  const url = new URL(raw || DEFAULT_BRIDGE_URL);
  if (url.protocol !== "http:") throw new Error("Use an http:// URL.");
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error("Use localhost or 127.0.0.1 for the bridge host.");
  return url.origin;
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.className = isError ? "error" : "";
}

async function load() {
  const { bridgeUrl } = await chrome.storage.sync.get({ bridgeUrl: DEFAULT_BRIDGE_URL });
  input.value = normalizeBridgeUrl(bridgeUrl);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const bridgeUrl = normalizeBridgeUrl(input.value);
    await chrome.storage.sync.set({ bridgeUrl });
    input.value = bridgeUrl;
    setStatus(`Saved ${bridgeUrl}`);
  } catch (e) {
    setStatus(e.message, true);
  }
});

reset.addEventListener("click", async () => {
  await chrome.storage.sync.set({ bridgeUrl: DEFAULT_BRIDGE_URL });
  input.value = DEFAULT_BRIDGE_URL;
  setStatus(`Reset to ${DEFAULT_BRIDGE_URL}`);
});

load().catch((e) => setStatus(e.message, true));
