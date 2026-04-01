import path from 'path';
import os from 'os';

function defaultDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'OpenSearch');
  }
  // Linux/Windows: use XDG or cwd fallback
  return process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'OpenSearch')
    : path.join(process.cwd(), 'data');
}

export const DATA_DIR = process.env.DATA_DIR || process.env.ANN_DATA_DIR || defaultDataDir();
