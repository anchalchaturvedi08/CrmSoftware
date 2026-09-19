/**
 * Starts the project-local MongoDB replica set and initiates it if needed.
 * Idempotent: safe to run when the instance is already up.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  DATA_DIR, DB_NAME, HOST, LOG_FILE, MONGO_URI, PID_FILE, PORT, REPL_SET,
  ensureDirs, findMongod, isPortOpen, runMongosh, waitForPort,
} from './db-config.mjs';

async function startMongod() {
  if (await isPortOpen()) {
    console.log(`mongod already listening on ${HOST}:${PORT}`);
    return;
  }

  ensureDirs();
  const mongod = findMongod();
  if (!mongod) {
    throw new Error(
      'mongod could not be found. Install MongoDB Server, or add it to PATH.',
    );
  }
  console.log(`starting mongod (${mongod}) on ${HOST}:${PORT} ...`);

  const child = spawn(
    mongod,
    [
      '--replSet', REPL_SET,
      '--port', String(PORT),
      '--dbpath', DATA_DIR,
      '--logpath', LOG_FILE,
      '--bind_ip', HOST,
    ],
    /* detached + unref + ignored stdio is what lets mongod outlive the shell
       that started it. windowsHide keeps a console window from flashing up,
       and also keeps mongod off that console's signal group, so closing the
       terminal is less likely to take the database down with it. */
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');

  if (!(await waitForPort())) {
    throw new Error(
      `mongod did not start listening on ${HOST}:${PORT} within 30s. ` +
      `Check the log at ${LOG_FILE}`,
    );
  }
  console.log('mongod is listening');
}

/**
 * Initiates the replica set the first time, then waits for this node to be
 * elected PRIMARY. Without a PRIMARY, writes and transactions both fail.
 */
function ensureReplicaSet() {
  const state = runMongosh(
    'try { print(rs.status().set) } catch (e) { print("UNINITIALIZED:" + e.codeName) }',
  );

  if (state.startsWith('UNINITIALIZED')) {
    console.log(`initiating replica set ${REPL_SET} ...`);
    const out = runMongosh(
      `rs.initiate({_id:"${REPL_SET}", members:[{_id:0, host:"${HOST}:${PORT}"}]})`,
    );
    if (!out.includes('ok: 1') && !out.includes('"ok": 1')) {
      throw new Error(`rs.initiate() did not report ok:1 - got:\n${out}`);
    }
  } else {
    console.log(`replica set ${state} already initiated`);
  }

  console.log('waiting for PRIMARY ...');
  const primary = runMongosh(`
    let tries = 0;
    while (tries++ < 60) {
      try { if (db.hello().isWritablePrimary) { print("IS_PRIMARY"); quit(); } } catch (e) {}
      sleep(500);
    }
    print("NOT_PRIMARY");
  `);
  if (!primary.includes('IS_PRIMARY')) {
    throw new Error('node did not become PRIMARY within 30s - transactions will fail');
  }
  console.log('node is PRIMARY - transactions available');
}

try {
  await startMongod();
  ensureReplicaSet();
  console.log(`\nready: ${MONGO_URI}`);
  console.log(`database: ${DB_NAME}`);
} catch (err) {
  console.error(`\ndb:start failed - ${err.message}`);
  process.exit(1);
}
