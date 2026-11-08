'use strict';

const fs = require('node:fs');
const path = require('node:path');

function canonicalPath(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new TypeError('A directory path is required');
  let current = path.resolve(candidate);
  const missing = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return path.resolve(real, ...missing.reverse());
    } catch (error) {
      if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function normalized(candidate) {
  const resolved = canonicalPath(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSamePhysicalPath(left, right) {
  return normalized(left) === normalized(right);
}

function isPathWithin(candidate, root) {
  const child = normalized(candidate);
  const parent = normalized(root);
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

module.exports = { canonicalPath, isSamePhysicalPath, isPathWithin };
