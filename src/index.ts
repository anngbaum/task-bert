import { Command } from 'commander';
import { copyDb } from './commands/copy-db.js';
import { embed } from './commands/embed.js';
import { search } from './commands/search.js';
import { status } from './commands/status.js';
import { unifiedSync } from './commands/unified-sync.js';
import { closePglite } from './db/pglite-client.js';
import type { SearchOptions } from './types.js';

const program = new Command();

program
  .name('open-search')
  .description('iMessage search engine with full-text and semantic search')
  .version('1.0.0');

program
  .command('copy-db')
  .description('Copy iMessage database locally')
  .option('--force', 'Force re-copy even if up to date')
  .action(async (opts) => {
    try {
      await copyDb(opts);
    } catch (err) {
      console.error('Error:', err);
      process.exit(1);
    }
  });

program
  .command('ingest')
  .description('Full re-ingest: wipe DB and import all messages (alias for resync)')
  .option('--batch-size <n>', 'Embedding batch size', '200')
  .action(async (opts) => {
    try {
      await unifiedSync({
        mode: 'hardReset',
        embedBatchSize: parseInt(opts.batchSize, 10),
      });
    } finally {
      await closePglite();
    }
  });

program
  .command('embed')
  .description('Generate vector embeddings for messages using local model')
  .option('--batch-size <n>', 'Batch size for embedding', '50')
  .action(async (opts) => {
    try {
      await embed({
        batchSize: parseInt(opts.batchSize, 10),
      });
    } finally {
      await closePglite();
    }
  });

program
  .command('search <query>')
  .description('Search messages')
  .option('--mode <mode>', 'Search mode: text, semantic, or hybrid', 'hybrid')
  .option('--from <contact>', 'Filter by sender identifier')
  .option('--group-chat-name <name>', 'Filter by group chat name')
  .option('--after <date>', 'Show messages after date (YYYY-MM-DD)')
  .option('--before <date>', 'Show messages before date (YYYY-MM-DD)')
  .option('--from-me', 'Only show messages sent by me')
  .option('--to-me', 'Only show messages received')
  .option('--limit <n>', 'Max results', '20')
  .option('--context <n>', 'Surrounding messages to show', '0')
  .action(async (query: string, opts) => {
    const searchOptions: SearchOptions = {
      mode: opts.mode as SearchOptions['mode'],
      from: opts.from,
      groupChatName: opts.groupChatName,
      after: opts.after,
      before: opts.before,
      fromMe: opts.fromMe || false,
      toMe: opts.toMe || false,
      limit: parseInt(opts.limit, 10),
      offset: 0,
      context: parseInt(opts.context, 10),
    };

    try {
      await search(query, searchOptions);
    } finally {
      await closePglite();
    }
  });

program
  .command('sync')
  .description('Incrementally sync new messages since last import')
  .option('--skip-embed', 'Skip embedding step')
  .option('--skip-metadata', 'Skip metadata/actions update')
  .action(async (opts) => {
    // If the server is running, delegate to it
    try {
      const res = await fetch('http://localhost:11488/api/sync', { method: 'POST' });
      if (res.ok) {
        const result = await res.json() as { messagesAdded: number; lastSynced: string };
        console.log(`Sync complete (via server): ${result.messagesAdded} messages synced`);
        console.log(`Last synced: ${result.lastSynced}`);
        return;
      }
    } catch {
      // Server not running, fall back to direct sync
    }

    try {
      await unifiedSync({
        mode: 'pullLatest',
        skipEmbed: opts.skipEmbed,
        skipMetadata: opts.skipMetadata,
      });
    } finally {
      await closePglite();
    }
  });

program
  .command('resync')
  .description('Wipe local DB, re-ingest all messages, embed, and update metadata')
  .option('--skip-embed', 'Skip embedding step')
  .option('--skip-metadata', 'Skip metadata/actions update')
  .option('--batch-size <n>', 'Embedding batch size', '200')
  .action(async (opts) => {
    try {
      await unifiedSync({
        mode: 'hardReset',
        skipEmbed: opts.skipEmbed,
        skipMetadata: opts.skipMetadata,
        embedBatchSize: parseInt(opts.batchSize, 10),
      });
    } finally {
      await closePglite();
    }
  });

program
  .command('status')
  .description('Show database statistics')
  .action(async () => {
    try {
      await status();
    } finally {
      await closePglite();
    }
  });

program.parse();
