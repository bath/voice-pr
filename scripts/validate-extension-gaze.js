import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("extension/manifest.json"));
const content = read("extension/content.js");
const background = read("extension/background.js");
const gazeHtml = read("extension/gaze.html");
const gazeJs = read("extension/gaze.js");
const readme = read("README.md");

function assert(condition, message) {
  if (!condition) {
    console.error(`extension gaze validation failed: ${message}`);
    process.exitCode = 1;
  }
}

const resources = manifest.web_accessible_resources?.flatMap((entry) => entry.resources || []) || [];
for (const resource of ["gaze.html", "gaze.css", "gaze.js", "vendor/webgazer.js"]) {
  assert(resources.includes(resource), `${resource} must be web-accessible to the GitHub content script`);
}

assert(!manifest.permissions?.includes("scripting"), "WebGazer should not require chrome.scripting tab injection");
assert(!background.includes("executeScript"), "background worker must not inject WebGazer into the GitHub tab");
assert(!background.includes("inject-webgazer"), "legacy inject-webgazer message handler must stay removed");
assert(!content.includes("window.webgazer"), "content script must not execute WebGazer on github.com");
assert(!content.includes("inject-webgazer"), "content script must not request WebGazer tab injection");

assert(content.includes('chrome.runtime.getURL("gaze.html")'), "content script must create the extension-origin overlay");
assert(content.includes('gazeFrame.allow = "camera"'), "gaze iframe must explicitly allow camera permission");
assert(content.includes("event.origin !== GAZE_ORIGIN"), "content script must origin-check gaze messages");
assert(content.includes("voice-pr-gaze-command"), "content script must send typed gaze commands to the overlay");
assert(content.includes("voice-pr-gaze"), "content script must receive typed gaze events from the overlay");

assert(gazeHtml.indexOf('src="vendor/webgazer.js"') < gazeHtml.indexOf('src="gaze.js"'), "gaze page must load WebGazer before its controller");
assert(gazeJs.includes("window.webgazer.begin()"), "gaze page must start WebGazer inside extension origin");
assert(gazeJs.includes("navigator.mediaDevices?.getUserMedia"), "gaze page must own camera API capability check");
assert(gazeJs.includes("recordScreenPosition"), "gaze page must accept forwarded calibration clicks");

const csp = manifest.content_security_policy?.extension_pages || "";
assert(csp.includes("http://localhost:4100"), "extension CSP must keep allowing the local bridge");
for (const host of ["https://tfhub.dev", "https://www.kaggle.com", "https://storage.googleapis.com"]) {
  assert(csp.includes(host), `extension CSP must document/allow current WebGazer model host ${host}`);
}
assert(!csp.includes("*"), "extension CSP must not allow wildcard model egress");
assert(readme.includes("does **not** vendor WebGazer's face-model assets"), "README must document the zero-network model vendoring gap");

if (!process.exitCode) console.log("extension gaze validation passed");
