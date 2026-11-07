'use strict';
/*
 * Microsoft Store(MSIX) 타일·로고 이미지를 build/appx/ 에 만든다 (npm run store-assets).
 * 앱 아이콘 생성기(build-icon.js)를 그대로 써서 투명 배경 PNG 를 그린다. electron-builder 가 이 이름들을 찾는다.
 */
const fs = require('fs');
const path = require('path');
const { png, canvasPng } = require('../build-icon.js');

const dir = path.join(__dirname, '..', 'build', 'appx');
fs.mkdirSync(dir, { recursive: true });
const files = {
  'StoreLogo.png': png(50),
  'Square44x44Logo.png': png(44),
  'Square150x150Logo.png': png(150),
  'SmallTile.png': png(71),
  'LargeTile.png': png(310),
  'BadgeLogo.png': png(24),
  'Wide310x150Logo.png': canvasPng(310, 150, 128),
  'SplashScreen.png': canvasPng(620, 300, 200),
};
for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), buf);
console.log(`Store 이미지 ${Object.keys(files).length}개 → ${path.relative(process.cwd(), dir)}`);
