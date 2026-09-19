/** Reports whether the project-local MongoDB is up, PRIMARY, and transaction-capable. */
import { HOST, LOG_FILE, PORT, isPortOpen, runMongosh } from './db-config.mjs';

if (!(await isPortOpen())) {
  console.log(`DOWN - nothing listening on ${HOST}:${PORT}`);
  console.log('start it with:  npm run db:start');
  process.exit(1);
}

console.log(`UP on ${HOST}:${PORT}`);

try {
  const report = runMongosh(`
    print("primary:      " + db.hello().isWritablePrimary);
    try { print("replSet:      " + rs.status().set); }
    catch (e) { print("replSet:      NONE (" + e.codeName + ")"); }

    const s = db.getMongo().startSession();
    try {
      s.startTransaction();
      s.getDatabase("txn_probe").probe.insertOne({ at: new Date() });
      s.commitTransaction();
      print("transactions: OK");
    } catch (e) {
      print("transactions: FAILING (" + e.codeName + ")");
      try { s.abortTransaction(); } catch (_) {}
    } finally {
      s.endSession();
      const _cleanup = db.getSiblingDB("txn_probe").dropDatabase();
    }
  `);
  console.log(report);
  console.log(`log:          ${LOG_FILE}`);

  if (report.includes('transactions: FAILING')) {
    console.error('\ntransactions are not available - spec section 19 requires them');
    process.exit(1);
  }
} catch (err) {
  console.error(`could not query the instance - ${err.message}`);
  process.exit(1);
}
