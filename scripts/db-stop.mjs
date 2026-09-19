/** Shuts the project-local MongoDB down cleanly via its admin command. */
import fs from 'node:fs';
import { HOST, PID_FILE, PORT, isPortOpen, runMongosh } from './db-config.mjs';

if (!(await isPortOpen())) {
  console.log(`already down - nothing listening on ${HOST}:${PORT}`);
  process.exit(0);
}

// A clean shutdown drops the connection mid-command, so mongosh reporting a
// non-zero exit here is the expected outcome, not a failure.
runMongosh(
  'try { db.getSiblingDB("admin").shutdownServer({ force: false }) } catch (e) {}',
  { allowFailure: true },
);

if (await isPortOpen()) {
  console.error('mongod did not shut down; it may need to be stopped manually');
  process.exit(1);
}

fs.rmSync(PID_FILE, { force: true });
console.log('mongod stopped');
