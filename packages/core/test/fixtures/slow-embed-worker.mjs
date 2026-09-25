import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

// Answers after the number of milliseconds given as the first text, leaving started-/finished- markers in the cache dir.
parentPort.on('message', ({ id, texts }) => {
  writeFileSync(join(workerData.cacheDir, `started-${id}`), '');
  setTimeout(() => {
    writeFileSync(join(workerData.cacheDir, `finished-${id}`), '');
    const data = new Float32Array(texts.length * 2).fill(Math.SQRT1_2);
    parentPort.postMessage({ type: 'result', id, dims: [texts.length, 2], data }, [data.buffer]);
  }, Number(texts[0]));
});
parentPort.postMessage({ type: 'ready' });
