import { parentPort, workerData } from 'node:worker_threads';
import { env, pipeline } from '@huggingface/transformers';

interface EmbedWorkerData {
  cacheDir: string;
  modelId: string;
  pooling: 'cls' | 'mean';
}

interface EmbedRequest {
  id: number;
  texts: string[];
}

const port = parentPort;
if (!port) throw new Error('embed-worker must run in a worker thread');
const { cacheDir, modelId, pooling } = workerData as EmbedWorkerData;
env.cacheDir = cacheDir;

try {
  const extract = await pipeline('feature-extraction', modelId, { dtype: 'q8' });
  port.on('message', async ({ id, texts }: EmbedRequest) => {
    try {
      const output = await extract(texts, { pooling, normalize: true });
      const data = Float32Array.from(output.data as Float32Array);
      port.postMessage({ type: 'result', id, dims: output.dims, data }, [data.buffer]);
    } catch (error) {
      port.postMessage({ type: 'failed', id, message: (error as Error).message });
    }
  });
  port.postMessage({ type: 'ready' });
} catch (error) {
  port.postMessage({ type: 'error', message: `cannot load ${modelId}: ${(error as Error).message}` });
}
