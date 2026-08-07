#!/usr/bin/env node
/* Is docs/sw.js current with docs/?
 *
 * Forgetting to regenerate is silent and expensive: the worker keeps its old
 * version string, so no browser ever learns there is an update, and the new
 * files are missing from the precache list so offline play breaks. Run this in
 * CI or before deploying.  Exit 1 means "run node tools/make-sw.js". */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(__dirname, '..', 'docs', 'sw.js');
const before = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
execFileSync(process.execPath, [path.join(__dirname, 'make-sw.js')], { stdio: 'ignore' });
const after = fs.readFileSync(OUT, 'utf8');

if (before === after) {
  console.log('sw.js is up to date');
  process.exit(0);
}
if (before === null) console.error('sw.js did not exist — it has been generated');
else {
  fs.writeFileSync(OUT, before);     // leave the tree as we found it
  console.error('sw.js is STALE. Run: node tools/make-sw.js');
}
process.exit(1);
