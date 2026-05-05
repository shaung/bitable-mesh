import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let currentLevel: number = LEVELS.info;

const LOG_DIR = join(homedir(), '.bitable-mesh', 'logs');
const LOG_FILE = join(LOG_DIR, 'app.log');

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

export function setLogLevel(verbosity: number): void {
  if (verbosity >= 2) currentLevel = LEVELS.debug;
  else currentLevel = LEVELS.info;
}

function log(level: Level, ...args: unknown[]): void {
  if (LEVELS[level] < currentLevel) return;
  const msg = `[${new Date().toISOString()}] [${level}] ${args.join(' ')}`;
  // Write to file (reliable, no buffering issues with PM2)
  try { ensureLogDir(); appendFileSync(LOG_FILE, msg + '\n'); } catch {}
  // Also write to stdout (visible when running directly)
  console.log(msg);
}

export const logger = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info: (...args: unknown[]) => log('info', ...args),
  warn: (...args: unknown[]) => log('warn', ...args),
  error: (...args: unknown[]) => log('error', ...args),
};
