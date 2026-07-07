#!/bin/sh
set -e

node --check server.js
node --check public/app.js
node --check extension/anchors.js
node --check extension/content.js
node --check extension/background.js
node --check extension/gaze.js
for f in lib/*.js; do
  node --check "$f"
done
