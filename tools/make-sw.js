#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════
   Generate docs/sw.js from tools/sw-template.js.

   The precache list and the version are baked into the worker rather than
   fetched at runtime, because a browser decides an update exists by
   byte-comparing sw.js itself. A worker that read its file list from a
   separate manifest would never notice that the manifest changed.

   The version is a hash of every file's contents, so regenerating without
   editing anything produces an identical worker and no spurious "update
   available" prompt — and any real change produces a new one.

   Run before deploying:  node tools/make-sw.js
   ══════════════════════════════════════════════════════════════ */

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', 'docs');
const OUT = path.join(ROOT, 'sw.js');
const TEMPLATE = path.join(__dirname, 'sw-template.js');

/** Files that are part of the app, in a stable order. */
const SKIP = new Set(['sw.js', '.nojekyll', '.DS_Store']);
function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const rel = base ? `${base}/${name}` : name;
    if (SKIP.has(rel) || SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

const files = walk(ROOT);
const hash = crypto.createHash('sha1');
for (const rel of files) {
  hash.update(rel);
  hash.update(fs.readFileSync(path.join(ROOT, rel)));
}
const version = hash.digest('hex').slice(0, 12);

// './' is the navigation entry; index.html is also listed so a direct link to
// it resolves offline too.
const precache = ['./', ...files];

const sw = fs.readFileSync(TEMPLATE, 'utf8')
  .replace("'__VERSION__'", JSON.stringify(version))
  .replace('__PRECACHE__', JSON.stringify(precache, null, 2).replace(/\n/g, '\n'));

const previous = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
fs.writeFileSync(OUT, sw);

const bytes = files.reduce((n, f) => n + fs.statSync(path.join(ROOT, f)).size, 0);
console.log(`sw.js ${previous === sw ? 'unchanged' : 'updated'} — version ${version}`);
console.log(`  ${files.length} files precached, ${(bytes / 1024).toFixed(0)} KB`);
if (previous && previous !== sw) {
  const old = previous.match(/const VERSION = '([^']+)'/);
  if (old) console.log(`  previous version ${old[1]} — clients will be offered the update`);
}
