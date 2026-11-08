'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openVault } = require('../vault');
const migrationApi = (() => {
  try { return require('../store-migration'); } catch { return {}; }
})();

const png = (label) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(label),
]);

function safeStorage() {
  const wrappingKey = Buffer.alloc(32, 0x6d);
  return {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    async decryptStringAsync(envelope) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, envelope.subarray(0, 12));
      decipher.setAuthTag(envelope.subarray(12, 28));
      return {
        result: Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString('utf8'),
        shouldReEncrypt: false,
      };
    },
  };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capturebox-migration-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'custom-captures');
  const keyFile = path.join(root, 'profile', 'vault-key.bin');
  const stateFile = path.join(root, 'profile', 'vault-state.bin');
  fs.mkdirSync(directory, { recursive: true });
  const vault = await openVault({ safeStorage: safeStorage(), keyFile, stateFile });
  return { root, directory, keyFile, stateFile, vault };
}

function migration() {
  assert.equal(typeof migrationApi.migrateIndexedFiles, 'function', 'store-migration.js must export migrateIndexedFiles');
  return migrationApi.migrateIndexedFiles;
}

function idOf(n) { return `migr${n}abc12`; }

test('migrates only indexed images, thumbnails, and index after verifying encrypted copies', async (t) => {
  const { directory, vault } = await fixture(t);
  const assets = [
    { id: idOf(1), name: 'Region capture', width: 20, height: 10, createdAt: 1700000000000 },
    { id: idOf(2), name: 'Window capture', width: 30, height: 15, createdAt: 1700000000001 },
  ];
  const originals = new Map();
  for (const asset of assets) {
    const image = png(asset.id);
    const thumb = png(`${asset.id} thumb`);
    originals.set(`${asset.id}.png`, image);
    originals.set(`${asset.id}.thumb.png`, thumb);
    fs.writeFileSync(path.join(directory, `${asset.id}.png`), image);
    fs.writeFileSync(path.join(directory, `${asset.id}.thumb.png`), thumb);
  }
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(assets, null, 1));
  const unrelated = Buffer.from('user notes: keep these bytes');
  fs.writeFileSync(path.join(directory, 'notes.txt'), unrelated);

  const result = await migration()({ directory, assets, vault, makeThumbnail: () => png('generated') });

  assert.deepEqual(result, { assets });
  for (const [legacyName, contents] of originals) {
    const encryptedName = legacyName.endsWith('.thumb.png')
      ? legacyName.replace('.thumb.png', '.thumb.cbx')
      : legacyName.replace('.png', '.cbx');
    assert.deepEqual(vault.readFile(path.join(directory, encryptedName)), contents);
    assert.equal(fs.existsSync(path.join(directory, legacyName)), false);
  }
  assert.deepEqual(vault.readFile(path.join(directory, 'index.cbx')), Buffer.from(JSON.stringify(assets, null, 1)));
  assert.equal(fs.existsSync(path.join(directory, 'index.json')), false);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'notes.txt')), unrelated);
});

test('shared protected state takes precedence when discovering a custom capture folder', async (t) => {
  const { directory, vault } = await fixture(t);
  await vault.writeState(directory);
  const resolveCaptureDirectory = migrationApi.resolveCaptureDirectory;
  assert.equal(typeof resolveCaptureDirectory, 'function', 'store-migration.js must export resolveCaptureDirectory');
  assert.deepEqual(await resolveCaptureDirectory({ vault, legacySettings: { assetsDir: path.join(os.tmpdir(), 'old-folder') }, fallbackDirectory: os.tmpdir() }), {
    directory: path.resolve(directory),
    source: 'shared-state',
  });
});

test('uses the legacy assets folder when old captures exist and settings omit assetsDir', () => {
  assert.equal(typeof migrationApi.resolveFallbackDirectory, 'function');
  const legacyDirectory = path.join(os.tmpdir(), 'capturebox-old-profile', 'assets');
  const defaultDirectory = path.join(os.tmpdir(), 'Pictures', 'Screenshots');
  assert.equal(migrationApi.resolveFallbackDirectory({ legacyDirectory, defaultDirectory, legacyIndexExists: true }), path.resolve(legacyDirectory));
  assert.equal(migrationApi.resolveFallbackDirectory({ legacyDirectory, defaultDirectory, legacyIndexExists: false }), path.resolve(defaultDirectory));
});

test('an already encrypted index can open with a corrupt image so the protocol can report that item', () => {
  assert.equal(typeof migrationApi.shouldMigrateIndexedFiles, 'function');
  assert.equal(migrationApi.shouldMigrateIndexedFiles({ encryptedIndexExists: true, legacyIndexExists: false, legacyIndexedFilesExist: false }), false);
  assert.equal(migrationApi.shouldMigrateIndexedFiles({ encryptedIndexExists: true, legacyIndexExists: false, legacyIndexedFilesExist: true }), true);
});

test('initializes a new empty encrypted vault and preserves unrelated files', async (t) => {
  const { directory, vault } = await fixture(t);
  const unrelated = Buffer.from('keep this file');
  fs.writeFileSync(path.join(directory, 'notes.txt'), unrelated);

  await migration()({ directory, assets: [], vault });

  assert.deepEqual(vault.readFile(path.join(directory, 'index.cbx')), Buffer.from('[]'));
  assert.deepEqual(fs.readFileSync(path.join(directory, 'notes.txt')), unrelated);
});

test('does not replace a corrupt encrypted index without a legacy source', async (t) => {
  const { directory, vault } = await fixture(t);
  const corruptIndex = Buffer.from('corrupt encrypted index');
  fs.writeFileSync(path.join(directory, 'index.cbx'), corruptIndex);

  await assert.rejects(migration()({ directory, assets: [], vault }), /index|corrupt/i);

  assert.deepEqual(fs.readFileSync(path.join(directory, 'index.cbx')), corruptIndex);
});

test('preserves future-version encrypted image and thumbnail files alongside legacy sources', async (t) => {
  const { directory, vault } = await fixture(t);
  const assets = [{ id: idOf(9), name: 'Future', width: 2, height: 2, createdAt: 9 }];
  const image = png('legacy image');
  const thumb = png('legacy thumbnail');
  const futureImage = Buffer.concat([Buffer.from('CBX1'), Buffer.from([2]), Buffer.alloc(28, 7)]);
  const futureThumb = Buffer.concat([Buffer.from('CBX1'), Buffer.from([3]), Buffer.alloc(28, 8)]);
  fs.writeFileSync(path.join(directory, `${assets[0].id}.cbx`), futureImage);
  fs.writeFileSync(path.join(directory, `${assets[0].id}.thumb.cbx`), futureThumb);
  fs.writeFileSync(path.join(directory, `${assets[0].id}.png`), image);
  fs.writeFileSync(path.join(directory, `${assets[0].id}.thumb.png`), thumb);
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(assets, null, 1));

  await assert.rejects(migration()({ directory, assets, vault, makeThumbnail: () => png('generated') }), (error) =>
    error.code === 'ERR_VAULT_UNSUPPORTED_VERSION');

  assert.deepEqual(fs.readFileSync(path.join(directory, `${assets[0].id}.cbx`)), futureImage);
  assert.deepEqual(fs.readFileSync(path.join(directory, `${assets[0].id}.thumb.cbx`)), futureThumb);
  assert.deepEqual(fs.readFileSync(path.join(directory, `${assets[0].id}.png`)), image);
  assert.deepEqual(fs.readFileSync(path.join(directory, `${assets[0].id}.thumb.png`)), thumb);
  assert.equal(fs.existsSync(path.join(directory, 'index.json')), true);
});

test('preserves a future-version encrypted index alongside its legacy index', async (t) => {
  const { directory, vault } = await fixture(t);
  const legacyIndex = Buffer.from('[]');
  const futureIndex = Buffer.concat([Buffer.from('CBX1'), Buffer.from([2]), Buffer.alloc(28, 9)]);
  fs.writeFileSync(path.join(directory, 'index.cbx'), futureIndex);
  fs.writeFileSync(path.join(directory, 'index.json'), legacyIndex);

  await assert.rejects(migration()({ directory, assets: [], vault }), (error) =>
    error.code === 'ERR_VAULT_UNSUPPORTED_VERSION');

  assert.deepEqual(fs.readFileSync(path.join(directory, 'index.cbx')), futureIndex);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'index.json')), legacyIndex);
});

test('retries safely when valid encrypted copies coexist with legacy originals', async (t) => {
  const { directory, vault } = await fixture(t);
  const assets = [{ id: idOf(3), name: 'Existing', width: 2, height: 2, createdAt: 1 }];
  const image = png('already migrated');
  const thumb = png('legacy thumbnail');
  vault.writeFileAtomic(path.join(directory, `${assets[0].id}.cbx`), image);
  fs.writeFileSync(path.join(directory, `${assets[0].id}.png`), image);
  fs.writeFileSync(path.join(directory, `${assets[0].id}.thumb.png`), thumb);
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(assets, null, 1));

  await migration()({ directory, assets, vault, makeThumbnail: () => png('generated') });

  assert.deepEqual(vault.readFile(path.join(directory, `${assets[0].id}.cbx`)), image);
  assert.deepEqual(vault.readFile(path.join(directory, `${assets[0].id}.thumb.cbx`)), thumb);
  assert.equal(fs.existsSync(path.join(directory, `${assets[0].id}.png`)), false);
});

test('repairs a corrupt encrypted copy from the retained legacy original', async (t) => {
  const { directory, vault } = await fixture(t);
  const assets = [{ id: idOf(4), name: 'Recoverable', width: 3, height: 2, createdAt: 2 }];
  const image = png('recovery image');
  fs.writeFileSync(path.join(directory, `${assets[0].id}.cbx`), Buffer.from('broken encrypted copy'));
  fs.writeFileSync(path.join(directory, `${assets[0].id}.png`), image);
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(assets, null, 1));

  await migration()({ directory, assets, vault, makeThumbnail: () => png('recovered thumb') });

  assert.deepEqual(vault.readFile(path.join(directory, `${assets[0].id}.cbx`)), image);
  assert.equal(fs.existsSync(path.join(directory, `${assets[0].id}.png`)), false);
});

test('fails closed when an indexed asset has neither a valid encrypted copy nor a legacy image', async (t) => {
  const { directory, vault } = await fixture(t);
  const assets = [{ id: idOf(5), name: 'Missing', width: 3, height: 2, createdAt: 3 }];
  fs.writeFileSync(path.join(directory, `${assets[0].id}.cbx`), Buffer.from('broken encrypted copy'));
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(assets, null, 1));

  await assert.rejects(migration()({ directory, assets, vault, makeThumbnail: () => png('unused') }), /missing|corrupt|invalid|asset/i);
  assert.equal(fs.existsSync(path.join(directory, 'index.json')), true);
  assert.equal(fs.existsSync(path.join(directory, `${assets[0].id}.cbx`)), true);
});

test('keeps every legacy original when encrypted replacement verification fails', async (t) => {
  const { directory, vault } = await fixture(t);
  const assets = [{ id: idOf(6), name: 'Must remain', width: 4, height: 2, createdAt: 4 }];
  const image = png('preserve original on failure');
  fs.writeFileSync(path.join(directory, `${assets[0].id}.png`), image);
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(assets, null, 1));
  const faultyVault = {
    ...vault,
    writeFileAtomic: (filePath, bytes) => vault.writeFileAtomic(filePath, Buffer.from(bytes).fill(0)),
  };

  await assert.rejects(migration()({ directory, assets, vault: faultyVault, makeThumbnail: () => png('thumb') }), /verif|mismatch|corrupt/i);
  assert.deepEqual(fs.readFileSync(path.join(directory, `${assets[0].id}.png`)), image);
  assert.equal(fs.existsSync(path.join(directory, 'index.json')), true);
});
