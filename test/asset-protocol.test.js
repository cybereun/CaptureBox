'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protocolApi = (() => {
  try { return require('../asset-protocol'); } catch { return {}; }
})();
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function handler(options) {
  assert.equal(typeof protocolApi.createAssetProtocolHandler, 'function', 'asset-protocol.js must export createAssetProtocolHandler');
  return protocolApi.createAssetProtocolHandler(options);
}

async function responseFor(load, id, kind) {
  return load(new Request(`capturebox-asset://asset/${id}?kind=${kind}`));
}

test('internal image and thumbnail URLs decrypt only indexed assets and return PNG responses', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capturebox-asset-protocol-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const asset = { id: 'asset123', name: 'sample' };
  const files = new Map([
    [path.join(directory, `${asset.id}.cbx`), Buffer.concat([signature, Buffer.from('image')])],
    [path.join(directory, `${asset.id}.thumb.cbx`), Buffer.concat([signature, Buffer.from('thumb')])],
  ]);
  const vault = { readFile: (filePath) => files.get(filePath) || (() => { throw new Error('missing'); })() };
  const load = handler({ getDirectory: () => directory, getAssets: () => [asset], vault });

  for (const [kind, expected] of [['image', 'image'], ['thumb', 'thumb']]) {
    const response = await responseFor(load, asset.id, kind);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat([signature, Buffer.from(expected)]));
  }
});

test('unknown and malformed asset IDs return not found without reading a file', async () => {
  let reads = 0;
  const load = handler({ getDirectory: () => os.tmpdir(), getAssets: () => [{ id: 'asset123' }], vault: { readFile() { reads++; throw new Error('should not read'); } } });
  assert.equal((await responseFor(load, 'missing1', 'image')).status, 404);
  assert.equal((await responseFor(load, 'asset123!', 'image')).status, 404);
  assert.equal((await responseFor(load, 'asset123', 'raw')).status, 404);
  assert.equal(reads, 0);
});

test('corrupt ciphertext reports the affected capture but preserves its index entry', async () => {
  const reports = [];
  const asset = { id: 'asset123', name: 'Keep me' };
  const assets = [asset];
  const load = handler({
    getDirectory: () => os.tmpdir(),
    getAssets: () => assets,
    vault: { readFile() { throw new Error('authentication failed'); } },
    onError: (id, error) => reports.push({ id, message: error.message }),
  });
  const response = await responseFor(load, asset.id, 'image');
  assert.equal(response.status, 500);
  assert.deepEqual(reports, [{ id: asset.id, message: 'authentication failed' }]);
  assert.deepEqual(assets, [{ id: 'asset123', name: 'Keep me' }]);
});
