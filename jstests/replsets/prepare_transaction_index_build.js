/**
 * Tests that background index builds on secondaries block prepared transactions from being
 * prepared.
 * This behavior is necessary because hybrid index builds would otherwise miss prepared transaction
 * writes if the prepared transaction commits after a hybrid index build commits.  The long term
 * solution to this problem is to synchronize index build commits.
 *
 * @tags: [uses_transactions, uses_prepare_transaction]
 */
(function() {
    "use strict";
    load("jstests/core/txns/libs/prepare_helpers.js");

    const replTest = new ReplSetTest({nodes: 2});
    replTest.startSet();
    replTest.initiate();

    const primary = replTest.getPrimary();
    const secondary = replTest.getSecondary();

    const dbName = "test";
    const collName = "prepared_transactions_index_build";
    const testDB = primary.getDB(dbName);
    const testColl = testDB.getCollection(collName);

    assert.commandWorked(testDB.runCommand({create: collName, writeConcern: {w: "majority"}}));

    const bulk = testColl.initializeUnorderedBulkOp();
    for (let i = 0; i < 10; ++i) {
        bulk.insert({x: i});
    }
    assert.writeOK(bulk.execute());

    // activate failpoint to hang index build on secondary.
    secondary.getDB("admin").runCommand(
        {configureFailPoint: 'hangAfterStartingIndexBuild', mode: 'alwaysOn'});

    jsTestLog("Starting a background index build.");
    assert.commandWorked(testColl.createIndexes([{x: 1}], {}, {writeConcern: {w: 2}}));

    const session = primary.startSession({causalConsistency: false});
    const sessionDB = session.getDatabase(dbName);
    const sessionColl = sessionDB.getCollection(collName);

    jsTestLog("Starting a transaction that should involve the index and putting it into prepare");

    session.startTransaction();
    assert.commandWorked(sessionColl.insert({x: 1000}));

    const prepareTimestamp = PrepareHelpers.prepareTransaction(session);

    jsTestLog("Unblocking index build.");

    // finish the index build
    secondary.getDB("admin").runCommand(
        {configureFailPoint: 'hangAfterStartingIndexBuild', mode: 'off'});

    jsTestLog("Waiting for all index builds to finish on all nodes.");

    // wait for the index build to finish; we know it's done if the prepare has finished on the
    // secondary.
    replTest.awaitReplication();

    jsTestLog("Committing txn");
    // Commit the transaction.
    assert.commandWorked(PrepareHelpers.commitTransactionAfterPrepareTS(session, prepareTimestamp));
    replTest.awaitReplication();

    jsTestLog("Testing index integrity");
    // Index should work.
    assert.eq(1000,
              secondary.getDB(dbName)
                  .getCollection(collName)
                  .find({x: 1000})
                  .hint({x: 1})
                  .toArray()[0]
                  .x);
    jsTestLog("Shutting down the set");
    replTest.stopSet();
}());
