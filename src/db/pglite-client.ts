import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';

const PG_DATA_DIR = path.join(DATA_DIR, 'pgdata');
const SCHEMA_PATH = path.join(import.meta.dirname, 'schema.sql');

let client: PGlite | null = null;

export async function getPglite(): Promise<PGlite> {
  if (client) return client;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  client = new PGlite(PG_DATA_DIR, {
    extensions: { vector },
  });

  await client.waitReady;

  return client;
}

export async function initSchema(): Promise<void> {
  const db = await getPglite();
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');

  // Split on semicolons and execute each statement
  const statements = schema
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    await db.exec(stmt + ';');
  }

  // Migrations for existing databases
  try {
    await db.exec('ALTER TABLE key_events ADD COLUMN IF NOT EXISTS removed BOOLEAN DEFAULT FALSE;');
    await db.exec('ALTER TABLE key_events ADD COLUMN IF NOT EXISTS location TEXT;');
    await db.exec('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_id TEXT;');
  } catch {
    // Columns may already exist
  }

  // Migration: merge action_items + suggested_follow_ups → tasks
  try {
    const hasOldTables = await db.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'action_items') as has_actions,
              EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'suggested_follow_ups') as has_followups`
    );
    const { has_actions, has_followups } = hasOldTables.rows[0] as { has_actions: boolean; has_followups: boolean };

    if (has_actions || has_followups) {
      // Check if there's actually data to migrate (tables might exist but be empty on fresh installs)
      const tasksExist = await db.query(`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tasks') as exists`);
      if ((tasksExist.rows[0] as any).exists) {
        const taskCount = await db.query('SELECT count(*) as cnt FROM tasks');
        const needsMigration = (taskCount.rows[0] as any).cnt === '0' || (taskCount.rows[0] as any).cnt === 0;

        if (needsMigration) {
          if (has_actions) {
            await db.exec(`
              INSERT INTO tasks (chat_id, message_id, title, date, priority, completed, created_at)
              SELECT chat_id, message_id, title, date, 'high', completed, created_at
              FROM action_items
            `);
            console.log('[migration] Migrated action_items → tasks (priority: high)');
          }
          if (has_followups) {
            await db.exec(`
              INSERT INTO tasks (chat_id, message_id, title, date, priority, key_event_id, completed, created_at)
              SELECT chat_id, message_id, title, date, 'low', key_event_id, completed, created_at
              FROM suggested_follow_ups
            `);
            console.log('[migration] Migrated suggested_follow_ups → tasks (priority: low)');
          }
        }
      }

      // Drop old tables to remove stale FK constraints on key_events
      if (has_followups) {
        await db.exec('DROP TABLE IF EXISTS suggested_follow_ups');
        console.log('[migration] Dropped legacy suggested_follow_ups table');
      }
      if (has_actions) {
        await db.exec('DROP TABLE IF EXISTS action_items');
        console.log('[migration] Dropped legacy action_items table');
      }
    }
  } catch (err) {
    console.warn('[migration] Tasks migration skipped:', (err as Error).message);
  }
}

/**
 * Run cheap queries against core tables to verify the database isn't corrupted.
 * Returns true if healthy, false if something is wrong.
 */
export async function verifyDatabase(): Promise<boolean> {
  try {
    const db = await getPglite();
    // Check that core tables exist and are queryable
    await db.query('SELECT count(*) FROM message');
    await db.query('SELECT count(*) FROM handle');
    await db.query('SELECT count(*) FROM chat');
    await db.query('SELECT last_synced FROM sync_meta WHERE id = 1');
    return true;
  } catch (err) {
    console.error('[health] Database verification failed:', err);
    return false;
  }
}

/**
 * Wipe the PGLite data directory and reset the client so a fresh DB is created on next access.
 */
export async function wipePgliteData(): Promise<void> {
  await closePglite();
  if (fs.existsSync(PG_DATA_DIR)) {
    fs.rmSync(PG_DATA_DIR, { recursive: true, force: true });
    console.log('[health] Wiped corrupted PGLite data directory.');
  }
}

export async function closePglite(): Promise<void> {
  if (client) {
    const c = client;
    client = null; // Clear reference first to prevent re-use
    try {
      await c.close();
    } catch (err) {
      console.warn('[pglite] Error closing client:', err);
    }
  }
}
