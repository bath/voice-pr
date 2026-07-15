// Session-local authorization state for the capture surface. Intentionally has
// no storage dependency: choosing broader access must never silently become the
// default for a later page or browser session.
(function (global) {
  const LEVELS = [
    ["read_only", "Read only"],
    ["local_workspace", "Local workspace"],
    ["current_pr", "This pull request"],
    ["current_repo", "This repository"],
    ["connected_services", "Connected services"],
  ];
  const labels = new Map(LEVELS);
  const broad = new Set(["current_repo", "connected_services"]);

  function createAuthorizationController(initialLevel = "current_pr") {
    let value = labels.has(initialLevel) ? initialLevel : "current_pr";
    return {
      get value() { return value; },
      get label() { return labels.get(value); },
      get isBroad() { return broad.has(value); },
      set(next) {
        if (!labels.has(next)) throw new TypeError(`Unknown authorization level: ${next}`);
        value = next;
        return this.snapshot();
      },
      snapshot() {
        return { value, label: labels.get(value), isBroad: broad.has(value), persistence: "session" };
      },
    };
  }

  global.VoicePrAuthorization = { LEVELS, createAuthorizationController };
})(typeof globalThis !== "undefined" ? globalThis : window);
