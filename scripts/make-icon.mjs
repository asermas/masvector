// Uygulama ikonu (build/icon.png, 512×512): koyu zemin üzerinde bezier kalem ucu + çapa noktaları.
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';

const S = 512, c = createCanvas(S, S), x = c.getContext('2d');
x.fillStyle = '#1b1d22'; x.beginPath(); x.roundRect(16, 16, S - 32, S - 32, 104); x.fill();
const g = x.createLinearGradient(96, 96, 416, 416);
g.addColorStop(0, '#ff7a45'); g.addColorStop(1, '#7c4dff');
// Eğri
x.strokeStyle = g; x.lineWidth = 34; x.lineCap = 'round';
x.beginPath(); x.moveTo(110, 380); x.bezierCurveTo(150, 120, 360, 400, 402, 132); x.stroke();
// Kontrol kolları
x.strokeStyle = '#e8e8ea'; x.lineWidth = 8;
for (const [a, b] of [[[110, 380], [150, 120]], [[402, 132], [360, 400]]]) { x.beginPath(); x.moveTo(...a); x.lineTo(...b); x.stroke(); }
// Çapalar ve kol uçları
x.fillStyle = '#e8e8ea';
for (const [px, py] of [[110, 380], [402, 132]]) x.fillRect(px - 26, py - 26, 52, 52);
for (const [px, py] of [[150, 120], [360, 400]]) { x.beginPath(); x.arc(px, py, 20, 0, Math.PI * 2); x.fill(); }
writeFileSync(new URL('../build/icon.png', import.meta.url), c.toBuffer('image/png'));
console.log('build/icon.png yazıldı');
