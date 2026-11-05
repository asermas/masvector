// Render döngülü optimizasyonun worker gövdesi: @napi-rs/canvas getImageData tamponları süreç içinde serbest
// bırakılmıyor (sürüm 1.1.0'a kadar doğrulandı); worker kapanınca napi sonlandırıcıları çalışır ve bellek geri döner.
import { parentPort, workerData } from 'node:worker_threads';
import { refineGroup } from './refine.js';

const { group, ref, background, opts } = workerData;
const report = refineGroup(group, ref, background, opts);
parentPort!.postMessage({ group, report });
