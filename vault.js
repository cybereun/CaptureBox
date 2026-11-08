'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAGIC = Buffer.from('CBX1');
const VERSION = 1;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + 1 + NONCE_LENGTH + TAG_LENGTH;
const KEY_LENGTH = 32;
const MAX_REENCRYPT_ROUNDS = 4;

function asBuffer(value, label) {
  if (!Buffer.isBuffer(value)) throw new TypeError(`${label} must be a Buffer`);
  return value;
}

function atomicWriteFile(filePath, data) {
  const absolutePath = path.resolve(filePath);
  const directory = path.dirname(absolutePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(absolutePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, absolutePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* a later startup can clean a stale temp file */ }
    throw error;
  }
}

function encryptBuffer(buffer, key) {
  asBuffer(buffer, 'plaintext');
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ciphertext]);
}

function decryptBuffer(envelope, key) {
  asBuffer(envelope, 'encrypted data');
  if (envelope.length < HEADER_LENGTH || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Invalid CaptureBox vault file');
  }
  const version = envelope[MAGIC.length];
  if (version !== VERSION) throw new Error(`Unsupported CaptureBox vault version: ${version}`);
  const nonceStart = MAGIC.length + 1;
  const tagStart = nonceStart + NONCE_LENGTH;
  const ciphertextStart = tagStart + TAG_LENGTH;
  const nonce = envelope.subarray(nonceStart, tagStart);
  const tag = envelope.subarray(tagStart, ciphertextStart);
  const ciphertext = envelope.subarray(ciphertextStart);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function protectedString(safeStorage, value) {
  const encrypted = await safeStorage.encryptStringAsync(value);
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    throw new Error('Windows did not return protected key data');
  }
  return encrypted;
}

async function unprotectedString(safeStorage, filePath) {
  const encrypted = fs.readFileSync(filePath);
  if (encrypted.length === 0) throw new Error('Protected CaptureBox state file is empty');
  let result;
  let shouldReEncrypt = false;
  for (let attempt = 0; attempt < MAX_REENCRYPT_ROUNDS; attempt++) {
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    if (!decrypted || typeof decrypted.result !== 'string' || typeof decrypted.shouldReEncrypt !== 'boolean') {
      throw new Error('Windows could not return protected CaptureBox state');
    }
    result = decrypted.result;
    shouldReEncrypt ||= decrypted.shouldReEncrypt;
    if (!decrypted.shouldReEncrypt) break;
    if (attempt === MAX_REENCRYPT_ROUNDS - 1) throw new Error('Windows key protection is still rotating; retry later');
  }
  if (shouldReEncrypt) atomicWriteFile(filePath, await protectedString(safeStorage, result));
  return result;
}

function validateDirectory(directory) {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) {
    throw new Error('Invalid CaptureBox capture-directory state');
  }
  if (!path.isAbsolute(directory)) throw new Error('CaptureBox capture directory must be an absolute path');
  return path.resolve(directory);
}

async function openVault({ safeStorage, keyFile, stateFile, requireExistingKey = false } = {}) {
  if (!safeStorage || typeof safeStorage.isAsyncEncryptionAvailable !== 'function' ||
      typeof safeStorage.encryptStringAsync !== 'function' || typeof safeStorage.decryptStringAsync !== 'function') {
    throw new Error('Windows user-account encryption is unavailable');
  }
  const available = await safeStorage.isAsyncEncryptionAvailable();
  if (!available) throw new Error('Windows user-account encryption is not available yet');
  if (typeof keyFile !== 'string' || typeof stateFile !== 'string') {
    throw new TypeError('CaptureBox vault key and state file paths are required');
  }
  const protectedKeyFile = path.resolve(keyFile);
  const protectedStateFile = path.resolve(stateFile);
  if (protectedKeyFile.toLowerCase() === protectedStateFile.toLowerCase()) {
    throw new Error('CaptureBox vault key and state must use separate files');
  }
  fs.mkdirSync(path.dirname(protectedKeyFile), { recursive: true });
  let key;
  if (fs.existsSync(protectedKeyFile)) {
    const encoded = await unprotectedString(safeStorage, protectedKeyFile);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Protected CaptureBox key is invalid');
    key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_LENGTH) throw new Error('Protected CaptureBox key has an invalid length');
  } else {
    if (requireExistingKey || fs.existsSync(protectedStateFile)) {
      throw new Error('CaptureBox encryption key is missing; refusing to replace it while vault data may exist');
    }
    key = crypto.randomBytes(KEY_LENGTH);
    const protectedKey = await protectedString(safeStorage, key.toString('base64'));
    atomicWriteFile(protectedKeyFile, protectedKey);
  }

  return {
    encrypt(buffer) { return encryptBuffer(buffer, key); },
    decrypt(envelope) { return decryptBuffer(envelope, key); },
    readFile(filePath) { return decryptBuffer(fs.readFileSync(filePath), key); },
    writeFileAtomic(filePath, buffer) { atomicWriteFile(filePath, encryptBuffer(buffer, key)); },
    removeFile(filePath) { fs.rmSync(filePath, { force: true }); },
    async readState() {
      if (!fs.existsSync(protectedStateFile)) return null;
      let state;
      try { state = JSON.parse(await unprotectedString(safeStorage, protectedStateFile)); } catch (error) {
        throw new Error(`CaptureBox shared vault state cannot be read: ${error.message}`);
      }
      if (!state || typeof state !== 'object') throw new Error('CaptureBox shared vault state is invalid');
      return { directory: validateDirectory(state.directory) };
    },
    async writeState(directory) {
      const state = JSON.stringify({ version: 1, directory: validateDirectory(directory) });
      atomicWriteFile(protectedStateFile, await protectedString(safeStorage, state));
    },
  };
}

module.exports = { openVault };
