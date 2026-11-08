'use strict';

const path = require('node:path');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

function createAssetProtocolHandler({ getDirectory, getAssets, vault, onError } = {}) {
  if (typeof getDirectory !== 'function' || typeof getAssets !== 'function' || !vault || typeof vault.readFile !== 'function') {
    throw new TypeError('CaptureBox asset protocol requires a directory, index, and vault');
  }
  return async (request) => {
    let id = '';
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'capturebox-asset:' || url.hostname !== 'asset') return notFound();
      id = decodeURIComponent(url.pathname.slice(1));
      if (!/^[a-z0-9]{6,32}$/i.test(id) || url.pathname !== `/${id}`) return notFound();
      const kind = url.searchParams.get('kind');
      if (kind !== 'image' && kind !== 'thumb') return notFound();
      const assets = getAssets();
      if (!Array.isArray(assets) || !assets.some((asset) => asset && asset.id === id)) return notFound();
      const suffix = kind === 'thumb' ? '.thumb.cbx' : '.cbx';
      const bytes = vault.readFile(path.join(getDirectory(), `${id}${suffix}`));
      if (!Buffer.isBuffer(bytes) || bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error('Decrypted CaptureBox image is not a valid PNG');
      }
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      });
    } catch (error) {
      if (id && typeof onError === 'function') {
        try { onError(id, error); } catch { /* protocol response still fails closed */ }
      }
      return new Response('CaptureBox image unavailable', { status: 500, headers: { 'cache-control': 'no-store' } });
    }
  };
}

module.exports = { createAssetProtocolHandler };
