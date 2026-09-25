import { parentPort } from 'node:worker_threads';

parentPort.on('message', () => undefined);
parentPort.postMessage({ type: 'error', message: 'network unavailable' });
