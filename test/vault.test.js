'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vaultPath = path.join(__dirname, '..', 'vault.js');
const vaultApi = fs.existsSync(vaultPath) ? require(vaultPath) : {};
const MAGIC = Buffer.from('CBX1');

function requireOpenVault() {
  assert.equal(typeof vaultApi.openVault, 'function', 'vault.js must export openVault');
  return vaultApi.openVault;
}

function makeSafeStorage(options = {}) {
  const wrappingKey = options.wrappingKey || Buffer.alloc(32, 0x6d);
  return {
    shouldReEncrypt: false,
    async isAsyncEncryptionAvailable() { return options.available !== false; },
    async encryptStringAsync(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    async decryptStringAsync(encrypted) {
      const iv = encrypted.subarray(0, 12);
      const tag = encrypted.subarray(12, 28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, iv);
      decipher.setAuthTag(tag);
      const result = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8');
      return { result, shouldReEncrypt: this.shouldReEncrypt };
    },
  };
}

function tempFolder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capturebox-vault-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function makeVault(t, options = {}) {
  const directory = tempFolder(t);
  const keyFile = path.join(directory, 'vault-key.bin');
  const stateFile = path.join(directory, 'vault-state.bin');
  const openVault = requireOpenVault();
  const vault = await openVault({ safeStorage: options.safeStorage || makeSafeStorage(), keyFile, stateFile, ...options });
  return { directory, keyFile, stateFile, vault };
}

test('AES-GCM vault round-trips buffers with a fresh nonce and hides plaintext', async (t) => {
  const { vault } = await makeVault(t);
  const plain = Buffer.from('CaptureBox private screenshot payload 812943');
  const first = vault.encrypt(plain);
  const second = vault.encrypt(plain);
  assert.ok(first.subarray(0, 4).equals(MAGIC));
  assert.equal(first[4], 1);
  assert.notDeepEqual(first, second);
  assert.equal(first.includes(plain), false);
  assert.deepEqual(vault.decrypt(first), plain);
});

test('AES-GCM vault rejects a modified authentication tag', async (t) => {
  const { vault } = await makeVault(t);
  const envelope = vault.encrypt(Buffer.from('authenticated image bytes'));
  envelope[17] ^= 0x80;
  assert.throws(() => vault.decrypt(envelope));
});

test('AES-GCM vault rejects an unknown envelope version', async (t) => {
  const { vault } = await makeVault(t);
  const envelope = vault.encrypt(Buffer.from('image bytes'));
  envelope[4] = 2;
  assert.throws(() => vault.decrypt(envelope), /version/i);
});

test('key is protected, reloadable, and re-encrypted when safeStorage requests it', async (t) => {
  const directory = tempFolder(t);
  const keyFile = path.join(directory, 'vault-key.bin');
  const stateFile = path.join(directory, 'vault-state.bin');
  const safeStorage = makeSafeStorage();
  const openVault = requireOpenVault();
  const first = await openVault({ safeStorage, keyFile, stateFile });
  const plain = Buffer.from('image survives app restart');
  const envelope = first.encrypt(plain);
  const keyCiphertext = fs.readFileSync(keyFile);
  assert.equal(keyCiphertext.includes(Buffer.from('b64:')), false);
  const second = await openVault({ safeStorage, keyFile, stateFile });
  assert.deepEqual(second.decrypt(envelope), plain);
  safeStorage.shouldReEncrypt = true;
  let decryptCalls = 0;
  const decrypt = safeStorage.decryptStringAsync.bind(safeStorage);
  safeStorage.decryptStringAsync = async (value) => { decryptCalls++; return decrypt(value); };
  await openVault({ safeStorage, keyFile, stateFile });
  assert.equal(decryptCalls, 1, 'a persistent rotation signal must not cause repeated decryption');
  assert.notDeepEqual(fs.readFileSync(keyFile), keyCiphertext);
});

test('a missing key is not recreated when encrypted data requires the old key', async (t) => {
  const directory = tempFolder(t);
  const keyFile = path.join(directory, 'vault-key.bin');
  const stateFile = path.join(directory, 'vault-state.bin');
  fs.writeFileSync(stateFile, Buffer.from('protected state marker'));
  const openVault = requireOpenVault();
  await assert.rejects(openVault({ safeStorage: makeSafeStorage(), keyFile, stateFile, requireExistingKey: true }), /key/i);
  assert.equal(fs.existsSync(keyFile), false);
});

test('unavailable safeStorage does not create a plaintext key', async (t) => {
  const directory = tempFolder(t);
  const keyFile = path.join(directory, 'vault-key.bin');
  const stateFile = path.join(directory, 'vault-state.bin');
  const openVault = requireOpenVault();
  await assert.rejects(openVault({ safeStorage: makeSafeStorage({ available: false }), keyFile, stateFile }), /encrypt|protect|available/i);
  assert.equal(fs.existsSync(keyFile), false);
});

test('encrypted file reads and atomic writes never leave PNG bytes at rest', async (t) => {
  const { directory, vault } = await makeVault(t);
  const file = path.join(directory, 'sample.cbx');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from('sample image payload')]);
  vault.writeFileAtomic(file, png);
  const stored = fs.readFileSync(file);
  assert.equal(stored[0], 0x43);
  assert.equal(stored.includes(Buffer.from('sample image payload')), false);
  assert.deepEqual(vault.readFile(file), png);
});

test('shared capture-directory state is DPAPI-protected and round-trips', async (t) => {
  const { stateFile, vault } = await makeVault(t);
  const directory = path.join(os.tmpdir(), 'CaptureBox Custom Captures');
  await vault.writeState(directory);
  const encrypted = fs.readFileSync(stateFile);
  assert.equal(encrypted.includes(Buffer.from(directory)), false);
  assert.deepEqual(await vault.readState(), { directory });
});
