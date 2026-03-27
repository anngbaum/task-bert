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
    embedder = await (pipeline as Function)('feature-extraction', MODEL_ID, {
      dtype: 'q8',
      cache_dir: path.join(DATA_DIR, 'models'),
    }) as FeatureExtractionPipeline;
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
  const results: number[][] = [];
  for (const text of texts) {
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data as Float32Array));
  }
  return results;
}

export async function disposeEmbedder(): Promise<void> {
  if (embedder) {
    await embedder.dispose();
    embedder = null;
  }
}
