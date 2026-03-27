import { getPglite } from '../db/pglite-client.js';
import { getEmbeddingsBatch, disposeEmbedder } from '../embeddings/local.js';
import { updateSyncProgress } from '../progress.js';

/**
 * Returns true if a message has enough meaningful text content to produce
 * a useful embedding. Filters out emoji-only, very short, or
 * punctuation-only messages that create noise in vector search.
 */
function isEmbeddable(text: string): boolean {
  // Strip emoji, variation selectors, ZWJ, skin tone modifiers, and other symbol codepoints
  const withoutEmoji = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '');
  // Strip punctuation and whitespace
  const alphanumOnly = withoutEmoji.replace(/[\s\p{P}\p{S}]/gu, '');
  // Need at least 2 word characters remaining
  if (alphanumOnly.length < 2) return false;
  // Need at least 3 "words" (splits on whitespace) to carry meaningful semantic content
  const words = text.trim().split(/\s+/).filter((w) => w.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{P}]/gu, '').length > 0);
  return words.length >= 3;
}

interface EmbedOptions {
  batchSize?: number;
}

export async function embed(options: EmbedOptions = {}): Promise<void> {
  const batchSize = options.batchSize || 50;

  const db = await getPglite();

  // Repair any corrupted indexes from prior heavy writes (best-effort)
  try {
    console.log('Reindexing message table...');
    await db.query('REINDEX TABLE message');
  } catch (err) {
    console.warn('Reindex failed (non-fatal):', (err as Error).message);
  }

  // Count how many need embedding
  const countResult = await db.query(
    `SELECT COUNT(*) as count FROM message
     WHERE embedding IS NULL AND embedding_skipped = false
     AND text IS NOT NULL AND text != ''
     AND associated_message_type = 0`
  );
  const total = Number((countResult.rows[0] as { count: number }).count);

  if (total === 0) {
    console.log('All messages already have embeddings!');
    return;
  }

  console.log(`Generating embeddings for ${total} messages (batch size: ${batchSize})...`);
  console.log('Note: on first run the model (~135 MB) will be downloaded and cached.');

  let processed = 0;
  let errors = 0;

  while (true) {
    // Fetch next batch
    const batch = await db.query(
      `SELECT id, text FROM message
       WHERE embedding IS NULL AND embedding_skipped = false
       AND text IS NOT NULL AND text != ''
       AND associated_message_type = 0
       ORDER BY id
       LIMIT $1`,
      [batchSize]
    );

    if (batch.rows.length === 0) break;

    const allRows = batch.rows as { id: number; text: string }[];

    // Filter to messages with enough meaningful text content
    const rows = allRows.filter((r) => isEmbeddable(r.text));
    const skipIds = allRows.filter((r) => !isEmbeddable(r.text)).map((r) => r.id);

    // Mark non-embeddable messages as skipped so they aren't re-fetched.
    // We set embedding_skipped = true (see schema addition below).
    if (skipIds.length > 0) {
      const placeholders = skipIds.map((_, i) => `$${i + 1}`).join(', ');
      await db.query(
        `UPDATE message SET embedding_skipped = true WHERE id IN (${placeholders})`,
        skipIds
      );
    }

    try {
      const texts = rows.map((r) => r.text);
      const embeddings = texts.length > 0 ? await getEmbeddingsBatch(texts) : [];

      for (let i = 0; i < rows.length; i++) {
        const embeddingStr = `[${embeddings[i].join(',')}]`;
        await db.query(
          `UPDATE message SET embedding = $1::vector WHERE id = $2`,
          [embeddingStr, rows[i].id]
        );
      }

      processed += allRows.length;
      const pct = ((processed / total) * 100).toFixed(1);
      // Map embedding progress (0-100%) into the 25-85% overall range
      const overallPct = 25 + Math.round((processed / total) * 60);
      updateSyncProgress('embedding', `Embedding messages: ${processed.toLocaleString()}/${total.toLocaleString()} (${pct}%)`, overallPct);
      process.stdout.write(`  Progress: ${processed}/${total} (${pct}%)\r`);
    } catch (err) {
      errors++;
      console.error(`\nError processing batch at id ${rows[0].id}: ${err}`);
      if (errors > 5) {
        console.error('Too many errors, stopping.');
        break;
      }
      continue;
    }
  }

  await disposeEmbedder();

  console.log(`\nEmbedding complete! Processed ${processed} messages.`);
  if (errors > 0) {
    console.log(`  ${errors} batches had errors.`);
  }

  // HNSW index is expensive to build in PGLite WASM — skip by default.
  // Vector search uses exact scan (<=> operator) which is fine for this scale.
  console.log('Done. Vector search is now available.');
}
