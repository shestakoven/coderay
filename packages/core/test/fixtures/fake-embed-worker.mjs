import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, texts }) => {
  if (texts.includes('crash')) process.exit(3);
  const data = new Float32Array(
    texts.flatMap((text) => {
      const norm = Math.hypot(text.length, 1);
      return [text.length / norm, 1 / norm];
    }),
  );
  parentPort.postMessage({ type: 'result', id, dims: [texts.length, 2], data }, [data.buffer]);
});
parentPort.postMessage({ type: 'ready' });
