'use strict';

const fs = require('node:fs');
const path = require('node:path');

function assetId(value) {
  if (!value || typeof value.id !== 'string' || !/^[a-z0-9]{6,32}$/i.test(value.id)) {
    throw new Error('Legacy CaptureBox index contains an invalid asset ID');
  }
  return value.id;
}

function readEncrypted(vault, filePath) {
  try { return vault.readFile(filePath); } catch { return null; }
}

function verifyLegacyMatches(targetBytes, legacyBytes, label) {
  if (legacyBytes && !targetBytes.equals(legacyBytes)) {
    throw new Error(`Encrypted ${label} does not match its remaining legacy original`);
  }
}

function writeAndVerify(vault, targetPath, expectedBytes, label) {
  vault.writeFileAtomic(targetPath, expectedBytes);
  const verified = readEncrypted(vault, targetPath);
  if (!verified || !verified.equals(expectedBytes)) {
    throw new Error(`Encrypted ${label} failed verification`);
  }
}

async function migrateIndexedFiles({ directory, assets, vault, makeThumbnail }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('CaptureBox migration directory must be an absolute path');
  }
  if (!Array.isArray(assets) || !vault || typeof vault.readFile !== 'function' || typeof vault.writeFileAtomic !== 'function') {
    throw new Error('CaptureBox migration requires an asset index and an open vault');
  }
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true });
  const seen = new Set();
  const pendingRemoval = [];

  for (const asset of assets) {
    const id = assetId(asset);
    if (seen.has(id)) throw new Error(`Legacy CaptureBox index contains duplicate asset ID ${id}`);
    seen.add(id);

    const legacyImagePath = path.join(root, `${id}.png`);
    const encryptedImagePath = path.join(root, `${id}.cbx`);
    let legacyImage = fs.existsSync(legacyImagePath) ? fs.readFileSync(legacyImagePath) : null;
    let imageBytes = readEncrypted(vault, encryptedImagePath);
    if (imageBytes) verifyLegacyMatches(imageBytes, legacyImage, `image ${id}`);
    else if (legacyImage) {
      writeAndVerify(vault, encryptedImagePath, legacyImage, `image ${id}`);
      imageBytes = legacyImage;
    } else {
      throw new Error(`Indexed image ${id} is missing or corrupt`);
    }
    if (legacyImage) pendingRemoval.push(legacyImagePath);

    const legacyThumbPath = path.join(root, `${id}.thumb.png`);
    const encryptedThumbPath = path.join(root, `${id}.thumb.cbx`);
    const legacyThumb = fs.existsSync(legacyThumbPath) ? fs.readFileSync(legacyThumbPath) : null;
    let thumbBytes = readEncrypted(vault, encryptedThumbPath);
    if (thumbBytes) verifyLegacyMatches(thumbBytes, legacyThumb, `thumbnail ${id}`);
    else {
      let source = legacyThumb;
      if (!source) {
        if (typeof makeThumbnail !== 'function') throw new Error(`Thumbnail ${id} is missing and cannot be regenerated`);
        source = await makeThumbnail(imageBytes);
      }
      if (!Buffer.isBuffer(source)) throw new Error(`Thumbnail ${id} could not be generated`);
      writeAndVerify(vault, encryptedThumbPath, source, `thumbnail ${id}`);
      thumbBytes = source;
    }
    if (legacyThumb) pendingRemoval.push(legacyThumbPath);
  }

  const indexBytes = Buffer.from(JSON.stringify(assets, null, 1));
  const legacyIndexPath = path.join(root, 'index.json');
  const encryptedIndexPath = path.join(root, 'index.cbx');
  const legacyIndex = fs.existsSync(legacyIndexPath) ? fs.readFileSync(legacyIndexPath) : null;
  const encryptedIndex = readEncrypted(vault, encryptedIndexPath);
  if (legacyIndex) {
    let parsed;
    try { parsed = JSON.parse(legacyIndex.toString('utf8')); } catch (error) {
      throw new Error(`Legacy CaptureBox index is malformed: ${error.message}`);
    }
    if (!Array.isArray(parsed) || JSON.stringify(parsed) !== JSON.stringify(assets)) {
      throw new Error('Legacy CaptureBox index changed during migration');
    }
  }
  if (encryptedIndex) verifyLegacyMatches(encryptedIndex, legacyIndex && indexBytes, 'index');
  else if (legacyIndex) writeAndVerify(vault, encryptedIndexPath, indexBytes, 'index');
  else if (!fs.existsSync(encryptedIndexPath) && assets.length === 0) writeAndVerify(vault, encryptedIndexPath, indexBytes, 'index');
  else throw new Error('CaptureBox index is missing or corrupt');

  // No legacy file is removed until every indexed replacement has authenticated and matched.
  for (const legacyPath of pendingRemoval) fs.rmSync(legacyPath, { force: true });
  if (legacyIndex) fs.rmSync(legacyIndexPath, { force: true });
  return { assets };
}

async function resolveCaptureDirectory({ vault, legacySettings, fallbackDirectory }) {
  if (!vault || typeof vault.readState !== 'function') throw new Error('CaptureBox vault state is unavailable');
  const shared = await vault.readState();
  if (shared && typeof shared.directory === 'string') {
    return { directory: path.resolve(shared.directory), source: 'shared-state' };
  }
  if (legacySettings && typeof legacySettings.assetsDir === 'string' && legacySettings.assetsDir.trim()) {
    if (!path.isAbsolute(legacySettings.assetsDir)) throw new Error('Legacy CaptureBox capture directory must be absolute');
    return { directory: path.resolve(legacySettings.assetsDir), source: 'legacy-settings' };
  }
  if (typeof fallbackDirectory !== 'string' || !path.isAbsolute(fallbackDirectory)) {
    throw new Error('CaptureBox default capture directory is invalid');
  }
  return { directory: path.resolve(fallbackDirectory), source: 'default' };
}

function shouldMigrateIndexedFiles({ encryptedIndexExists, legacyIndexExists, legacyIndexedFilesExist }) {
  return !encryptedIndexExists || !!legacyIndexExists || !!legacyIndexedFilesExist;
}

module.exports = { migrateIndexedFiles, resolveCaptureDirectory, shouldMigrateIndexedFiles };
