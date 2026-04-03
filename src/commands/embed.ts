import { getPglite } from '../db/pglite-client.js';
import { getEmbeddingsBatch, disposeEmbedder } from '../embeddings/local.js';
import { updateEmbeddingProgress } from '../progress.js';

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
  const batchSize = options.batchSize || 200;
  const inferenceChunkSize = 16; // Balance between per-call overhead and memory/latency

  const db = await getPglite();

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
    updateEmbeddingProgress({ isRunning: false, total: 0, processed: 0 });
    return;
  }

  console.log(`Generating embeddings for ${total} messages (batch size: ${batchSize})...`);
  console.log('Note: on first run the model (~135 MB) will be downloaded and cached.');
  updateEmbeddingProgress({ isRunning: true, total, processed: 0 });

  let processed = 0;
  let errors = 0;
  let lastId = 0; // Cursor-based pagination — avoids re-scanning already-processed rows

  while (true) {
    // Fetch next batch using cursor (id > lastId) instead of scanning from the start
    const batch = await db.query(
      `SELECT id, text FROM message
       WHERE id > $2 AND embedding IS NULL AND embedding_skipped = false
       AND text IS NOT NULL AND text != ''
       AND associated_message_type = 0
       ORDER BY id
       LIMIT $1`,
      [batchSize, lastId]
    );

    if (batch.rows.length === 0) break;

    const allRows = batch.rows as { id: number; text: string }[];
    lastId = allRows[allRows.length - 1].id;

    // Filter to messages with enough meaningful text content
    const rows = allRows.filter((r) => isEmbeddable(r.text));
    const skipIds = allRows.filter((r) => !isEmbeddable(r.text)).map((r) => r.id);

    // Mark non-embeddable messages as skipped
    if (skipIds.length > 0) {
      const placeholders = skipIds.map((_, i) => `$${i + 1}`).join(', ');
      await db.query(
        `UPDATE message SET embedding_skipped = true WHERE id IN (${placeholders})`,
        skipIds
      );
    }

    try {
      const allEmbeddings: number[][] = [];

      for (let ci = 0; ci < rows.length; ci += inferenceChunkSize) {
        const chunkRows = rows.slice(ci, ci + inferenceChunkSize);
        const chunkTexts = chunkRows.map((r) => r.text);
        const chunkEmbeddings = await getEmbeddingsBatch(chunkTexts);
        allEmbeddings.push(...chunkEmbeddings);

        // Update progress after each inference chunk
        const chunkProcessed = processed + skipIds.length + ci + chunkRows.length;
        const pct = ((chunkProcessed / total) * 100).toFixed(1);
        updateEmbeddingProgress({ processed: chunkProcessed });
        console.log(`[embedding] ${chunkProcessed}/${total} (${pct}%)`);

        // Yield to the event loop so the HTTP server can respond to health checks
        await new Promise((r) => setTimeout(r, 0));
      }

      // Write embeddings in a single transaction to minimize overhead
      await db.exec('BEGIN');
      try {
        for (let wi = 0; wi < rows.length; wi++) {
          const embeddingStr = `[${allEmbeddings[wi].join(',')}]`;
          await db.query(
            `UPDATE message SET embedding = $1::vector WHERE id = $2`,
            [embeddingStr, rows[wi].id]
          );
        }
        await db.exec('COMMIT');
      } catch (writeErr) {
        await db.exec('ROLLBACK').catch(() => {});
        throw writeErr;
      }

      processed += allRows.length;
    } catch (err) {
      errors++;
      console.error(`\nError processing batch at id ${allRows[0].id}: ${err}`);
      if (errors > 5) {
        console.error('Too many errors, stopping.');
        break;
      }
      continue;
    }
  }

  await disposeEmbedder();
  updateEmbeddingProgress({ isRunning: false, processed, total });

  console.log(`\nEmbedding complete! Processed ${processed} messages.`);
  if (errors > 0) {
    console.log(`  ${errors} batches had errors.`);
  }

  console.log('Done. Vector search is now available.');
}
