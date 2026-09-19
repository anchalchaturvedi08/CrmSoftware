/**
 * Shared configuration and helpers for the project-local MongoDB replica set.
 *
 * We deliberately do NOT use the system MongoDB service on 27017: it runs
 * standalone, and MongoDB refuses multi-document transactions outside a
 * replica set. Spec §19 requires transactions for closure, parts issue/usage,
 * reassignment and reopen. See DECISIONS.md §2.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const MONGO_DIR = path.join(ROOT, '.mongo');
export const DATA_DIR = path.join(MONGO_DIR, 'data');
export const LOG_DIR = path.join(MONGO_DIR, 'log');
export const LOG_FILE = path.join(LOG_DIR, 'mongod.log');
export const PID_FILE = path.join(MONGO_DIR, 'mongod.pid');

export const PORT = 27018;
export const HOST = '127.0.0.1';
export const REPL_SET = 'rs0';
export const DB_NAME = 'cooler_crm';

export const MONGO_URI =
  `mongodb://${HOST}:${PORT}/${DB_NAME}?replicaSet=${REPL_SET}`;

/** Server versions to look for, newest first. Forward slashes are valid on Windows. */
const MONGO_VERSIONS = ['8.2', '8.1', '8.0', '7.0'];

/**
 * Resolve an executable, preferring explicit install paths and falling back to
 * a PATH lookup. On Windows, Node's spawn does not apply PATHEXT, so a bare
 * name like `mongosh` fails with ENOENT even when the shell resolves it —
 * hence the explicit `.exe` fallback.
 */
function resolveExe(candidates, fallbacks) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const fallback of fallbacks) {
    const probe = spawnSync(fallback, ['--version'], { encoding: 'utf8' });
    if (!probe.error) return fallback;
  }
  return null;
}

export function findMongod() {
  return resolveExe(
    MONGO_VERSIONS.map((v) => `C:/Program Files/MongoDB/Server/${v}/bin/mongod.exe`),
    ['mongod.exe', 'mongod'],
  );
}

export function findMongosh() {
  const home = os.homedir().split(path.sep).join('/');
  return resolveExe(
    [
      `${home}/AppData/Local/Programs/mongosh/mongosh.exe`,
      'C:/Program Files/mongosh/mongosh.exe',
      ...MONGO_VERSIONS.map((v) => `C:/Program Files/MongoDB/Server/${v}/bin/mongosh.exe`),
    ],
    ['mongosh.exe', 'mongosh'],
  );
}

/**
 * Run a script through mongosh against the local instance.
 * Throws loudly rather than returning empty output, so a missing shell can
 * never be mistaken for a healthy database.
 */
export function runMongosh(script, { allowFailure = false } = {}) {
  const shell = findMongosh();
  if (!shell) {
    throw new Error(
      'mongosh could not be found. Install the MongoDB Shell, or add it to PATH. ' +
      'Looked in ~/AppData/Local/Programs/mongosh and the MongoDB Server bin directories.',
    );
  }

  const result = spawnSync(
    shell,
    ['--host', HOST, '--port', String(PORT), '--quiet', '--eval', script],
    { encoding: 'utf8' },
  );

  if (result.error) {
    throw new Error(`could not run ${shell}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`mongosh exited ${result.status}${detail ? `:\n${detail}` : ''}`);
  }
  return (result.stdout ?? '').trim();
}

export function ensureDirs() {
  for (const dir of [DATA_DIR, LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Resolves true if something is accepting TCP connections on the port. */
export function isPortOpen(port = PORT, host = HOST, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** Polls the port until it opens, or the deadline passes. */
export async function waitForPort(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
