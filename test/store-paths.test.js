'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalPath, isSamePhysicalPath, isPathWithin } = require('../store-paths');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capturebox-store-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('canonical paths resolve junction aliases to the same physical directory', (t) => {
  const root = tempRoot(t);
  const captures = path.join(root, 'captures');
  const alias = path.join(root, 'capture-alias');
  fs.mkdirSync(captures);
  fs.writeFileSync(path.join(captures, 'keep.cbx'), 'encrypted bytes');
  fs.symlinkSync(captures, alias, 'junction');
  assert.equal(isSamePhysicalPath(captures, alias), true);
  assert.equal(canonicalPath(alias), canonicalPath(captures));
  fs.rmdirSync(alias);
  assert.equal(fs.readFileSync(path.join(captures, 'keep.cbx'), 'utf8'), 'encrypted bytes');
});

test('path containment follows junctions and handles not-yet-created children', (t) => {
  const root = tempRoot(t);
  const exports = path.join(root, 'temp-exports');
  const alias = path.join(root, 'exports-alias');
  fs.mkdirSync(exports);
  fs.symlinkSync(exports, alias, 'junction');
  assert.equal(isPathWithin(path.join(alias, 'captures'), exports), true);
  assert.equal(isPathWithin(path.join(root, 'captures'), exports), false);
});
