import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../config.js';

const SOURCE_DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const DEST_DB = path.join(DATA_DIR, 'chat.db');

export async function copyDb(options: { force?: boolean }): Promise<void> {
  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Check if already up to date (compare source DB + WAL mtimes)
  if (fs.existsSync(DEST_DB) && !options.force) {
    const srcMtime = Math.max(
      fs.statSync(SOURCE_DB).mtimeMs,
      fs.existsSync(SOURCE_DB + '-wal') ? fs.statSync(SOURCE_DB + '-wal').mtimeMs : 0
    );
    const destMtime = fs.statSync(DEST_DB).mtimeMs;
    if (destMtime >= srcMtime) {
      console.log('chat.db is already up to date. Use --force to re-copy.');
      return;
    }
    console.log('Source database is newer, copying...');
  }

  try {
    // Use SQLite backup API for a consistent, atomic snapshot that
    // properly includes any uncommitted WAL data.
    console.log(`Backing up ${SOURCE_DB} → ${DEST_DB}`);
    const src = new Database(SOURCE_DB, { readonly: true });

    // Remove stale destination so backup starts fresh
    for (const ext of ['', '-wal', '-shm']) {
      const f = DEST_DB + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    await src.backup(DEST_DB);
    src.close();

    const stat = fs.statSync(DEST_DB);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    console.log(`Done! Backed up ${sizeMB} MB to ./data/chat.db`);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EACCES') {
      console.error('\nPermission denied reading chat.db.');
      console.error('iMessage database requires Full Disk Access for your terminal app.');
      console.error('\nTo grant access:');
      console.error('  1. Open System Settings → Privacy & Security → Full Disk Access');
      console.error('  2. Enable your terminal app (Terminal, iTerm2, etc.)');
      console.error('  3. Restart your terminal and try again');
      process.exit(1);
    }
    throw err;
  }
}
