import path from 'path';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { DATA_DIR } from '../config.js';

// Point the HF transformers cache to the writable data directory
// so it doesn't try to write inside the (read-only) app bundle.
env.cacheDir = path.join(DATA_DIR, 'models');

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';

let embedder: FeatureExtractionPipeline | null = null;

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedder) {
    console.log('[embedder] Loading ONNX model...');
    const start = Date.now();
    embedder = await (pipeline as Function)('feature-extraction', MODEL_ID, {
      dtype: 'q8',
      cache_dir: path.join(DATA_DIR, 'models'),
    }) as FeatureExtractionPipeline;
    console.log(`[embedder] Model loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }
  return embedder;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

export async function getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  const pipe = await getEmbedder();
  const output = await pipe(texts, { pooling: 'mean', normalize: true });
  const dim = output.dims[output.dims.length - 1];
  const data = output.data as Float32Array;
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    results.push(Array.from(data.slice(i * dim, (i + 1) * dim)));
  }
  return results;
}

export async function disposeEmbedder(): Promise<void> {
  if (embedder) {
    await embedder.dispose();
    embedder = null;
  }
}
