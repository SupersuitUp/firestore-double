// The surface 0.2.0 adds: cursors, projections, FieldPath.documentId(), implicit inequality order,
// batches, contention retries, a read hook, and a Cloud Storage bucket double. Each test is a rule
// Firestore (or Cloud Storage) enforces, so a test that passes here does not fail in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirestore, createBucket, createFirebase } from "../src/index.mjs";

// firebase-admin's FieldPath.documentId() is a FieldPath whose only segment is "__name__".
const documentId = () => ({ segments: ["__name__"], formattedName: "__name__" });
const ids = (snap) => snap.docs.map((d) => d.id);

async function days() {
  const db = createFirestore();
  const col = db.collection("days");
  await col.doc("2031-04-03").set({ day: "2031-04-03", updatedAt: "2031-04-09" });
  await col.doc("2031-04-05").set({ day: "2031-04-05", updatedAt: "2031-04-06" });
  await col.doc("2031-04-04").set({ day: "2031-04-04", updatedAt: "2031-04-07" });
  await col.doc("no-stamp").set({ day: "2031-04-01" });
  return { db, col };
}

test("orderBy(FieldPath.documentId()) orders by id, and startAfter pages by id", async () => {
  const { col } = await days();
  assert.deepEqual(ids(await col.orderBy(documentId()).limit(2).get()), ["2031-04-03", "2031-04-04"]);
  assert.deepEqual(ids(await col.orderBy(documentId()).startAfter("2031-04-04").limit(2).get()), ["2031-04-05", "no-stamp"]);
  assert.deepEqual(ids(await col.orderBy(documentId(), "desc").startAfter("2031-04-04").get()), ["2031-04-03"]);
  assert.deepEqual(ids(await col.where("day", ">", "2031-04-01").orderBy(documentId()).get()), ["2031-04-03", "2031-04-04", "2031-04-05"]);
});

test("a document-id cursor with a slash is refused, as the SDK refuses it", async () => {
  const { col } = await days();
  assert.throws(() => col.orderBy(documentId()).startAfter("a/b"), /must be a plain document ID/);
});

test("startAfter, startAt, endAt and endBefore page by the orderBy field's value", async () => {
  const { col } = await days();
  assert.deepEqual(ids(await col.orderBy("updatedAt").startAfter("2031-04-06").get()), ["2031-04-04", "2031-04-03"]);
  assert.deepEqual(ids(await col.orderBy("updatedAt").startAt("2031-04-07").get()), ["2031-04-04", "2031-04-03"]);
  assert.deepEqual(ids(await col.orderBy("updatedAt").endAt("2031-04-07").get()), ["2031-04-05", "2031-04-04"]);
  assert.deepEqual(ids(await col.orderBy("updatedAt").endBefore("2031-04-07").get()), ["2031-04-05"]);
  assert.deepEqual(ids(await col.orderBy("updatedAt", "desc").startAfter("2031-04-09").get()), ["2031-04-04", "2031-04-05"]);
});

test("more cursor values than orderBy clauses is refused, including on an unordered query", async () => {
  const { col } = await days();
  assert.throws(() => col.startAfter("x"), /Too many cursor values specified/);
  assert.throws(() => col.where("updatedAt", ">", "2031").startAfter("2031-04-05"), /Too many cursor values specified/);
  assert.throws(() => col.orderBy("day").startAfter("a", "b"), /Too many cursor values specified/);
});

test("a snapshot cursor resumes after that document, through the implicit order by id", async () => {
  const { col } = await days();
  const first = await col.orderBy("day").limit(2).get();
  assert.deepEqual(ids(first), ["no-stamp", "2031-04-03"]);
  assert.deepEqual(ids(await col.orderBy("day").startAfter(first.docs[1]).get()), ["2031-04-04", "2031-04-05"]);
  assert.deepEqual(ids(await col.startAfter(first.docs[1]).get()), ["2031-04-04", "2031-04-05", "no-stamp"]);
});

test("an inequality filter with no orderBy answers by that field ascending, then by id", async () => {
  const { col } = await days();
  await col.doc("2031-04-02").set({ day: "2031-04-02", updatedAt: "2031-04-07" });
  assert.deepEqual(ids(await col.where("updatedAt", ">=", "2031-04-06").get()), ["2031-04-05", "2031-04-02", "2031-04-04", "2031-04-03"]);
  assert.deepEqual(ids(await col.where("day", "!=", "2031-04-01").get()), ["2031-04-02", "2031-04-03", "2031-04-04", "2031-04-05"]);
  // an equality filter does not reorder: document id order, as an unfiltered query
  assert.deepEqual(ids(await col.get()), ["2031-04-02", "2031-04-03", "2031-04-04", "2031-04-05", "no-stamp"]);
});

test("ties on an orderBy field break by id in the direction of the last orderBy", async () => {
  const db = createFirestore();
  for (const id of ["a", "b", "c"]) await db.doc(`t/${id}`).set({ n: 1 });
  assert.deepEqual(ids(await db.collection("t").orderBy("n", "desc").get()), ["c", "b", "a"]);
  assert.deepEqual(ids(await db.collection("t").orderBy("n").get()), ["a", "b", "c"]);
});

test("where on FieldPath.documentId() filters by id", async () => {
  const { col } = await days();
  assert.deepEqual(ids(await col.where(documentId(), "==", "2031-04-04").get()), ["2031-04-04"]);
  assert.deepEqual(ids(await col.where(documentId(), "in", ["no-stamp", "2031-04-03"]).get()), ["2031-04-03", "no-stamp"]);
});

test("select keeps only the named fields (a dotted path keeps its branch); select() keeps none", async () => {
  const db = createFirestore();
  await db.doc("j/a").set({ day: "a", updatedAt: "1", account: { at: "x", by: "y" } });
  const one = (await db.collection("j").select("day", "account.at").get()).docs[0];
  assert.equal(one.id, "a");
  assert.deepEqual(one.data(), { day: "a", account: { at: "x" } });
  assert.equal(one.get("updatedAt"), undefined);
  assert.deepEqual((await db.collection("j").select().get()).docs[0].data(), {});
  assert.deepEqual((await db.collection("j").orderBy("updatedAt").limit(1).select("updatedAt").get()).docs[0].data(), { updatedAt: "1" });
  assert.deepEqual(db.peek("j/a").account, { at: "x", by: "y" }); // the store is untouched
});

test("a batch lands every write at commit or none, and cannot be committed twice", async () => {
  const db = createFirestore();
  await db.doc("b/keep").set({ x: 1 });
  const ok = db.batch();
  ok.set(db.doc("b/1"), { x: 1 }).delete(db.doc("b/keep")).update(db.doc("b/1"), { y: 2 });
  assert.equal(db.peek("b/1"), undefined);
  await ok.commit();
  assert.deepEqual(db.peek("b/1"), { x: 1, y: 2 });
  assert.equal(db.peek("b/keep"), undefined);
  await assert.rejects(ok.commit(), /has already been committed/);
  assert.throws(() => ok.set(db.doc("b/2"), { x: 1 }), /has already been committed/);

  const bad = db.batch();
  bad.set(db.doc("b/2"), { x: 1 }).update(db.doc("b/missing"), { x: 1 });
  await assert.rejects(bad.commit(), (e) => e.code === 5);
  assert.equal(db.peek("b/2"), undefined);
  assert.throws(() => db.batch().set(db.doc("b/3"), { x: undefined }), /Cannot use "undefined"/);
});

test("a transaction whose read changed before commit runs again, and gives up with ABORTED after maxAttempts", async () => {
  const db = createFirestore();
  const ref = db.doc("c/n");
  await ref.set({ n: 0 });
  let runs = 0;
  await db.runTransaction(async (tx) => {
    runs++;
    const s = await tx.get(ref);
    if (runs === 1) await ref.set({ n: 10 }); // another writer, between the read and the commit
    tx.set(ref, { n: s.data().n + 1 });
  });
  assert.equal(runs, 2);
  assert.deepEqual(db.peek("c/n"), { n: 11 });

  runs = 0;
  await assert.rejects(db.runTransaction(async (tx) => {
    runs++;
    const s = await tx.get(ref);
    await ref.set({ n: s.data().n + 100 });
    tx.set(ref, { n: -1 });
  }, { maxAttempts: 3 }), (e) => e.code === 10);
  assert.equal(runs, 3);
  assert.notEqual(db.peek("c/n").n, -1);
});

test("a transaction that read a query runs again when the query's answer changed", async () => {
  const db = createFirestore();
  let runs = 0;
  await db.runTransaction(async (tx) => {
    runs++;
    const open = await tx.get(db.collection("q").where("open", "==", true));
    if (runs === 1) await db.doc("q/new").set({ open: true });
    tx.set(db.doc("tally/t"), { open: open.size });
  });
  assert.equal(runs, 2);
  assert.deepEqual(db.peek("tally/t"), { open: 1 });
});

test("a transaction callback must return a promise, as the SDK requires", async () => {
  const db = createFirestore();
  await assert.rejects(db.runTransaction(() => 1), /You must return a Promise in your transaction\(\)-callback/);
});

test("hooks.afterRead runs after a document read, by a plain get or inside a transaction", async () => {
  const db = createFirestore();
  await db.doc("h/a").set({ n: 1 });
  const seen = [];
  db.hooks.afterRead = async (path) => { seen.push(path); };
  const s = await db.doc("h/a").get();
  await db.runTransaction(async (tx) => { await tx.get(db.doc("h/a")); await tx.getAll(db.doc("h/b")); });
  assert.deepEqual(seen, ["h/a", "h/a", "h/b"]);
  assert.equal(s.data().n, 1);
  // a write made by the hook lands after the snapshot was taken, so the snapshot does not see it
  db.hooks.afterRead = async () => { db.hooks.afterRead = undefined; await db.doc("h/a").set({ n: 2 }); };
  assert.equal((await db.doc("h/a").get()).data().n, 1);
  assert.equal(db.peek("h/a").n, 2);
});

test("db.getAll reads several documents at once", async () => {
  const db = createFirestore();
  await db.doc("g/a").set({ n: 1 });
  const [a, b] = await db.getAll(db.doc("g/a"), db.doc("g/b"));
  assert.equal(a.data().n, 1);
  assert.equal(b.exists, false);
});

test("the bucket stores bytes with metadata, signs urls it records, and answers a missing object with 404", async () => {
  const { bucket, files, signed, downloads } = createBucket();
  const f = bucket.file("p/a.jpg");
  assert.deepEqual(await f.exists(), [false]);
  await assert.rejects(f.download(), (e) => e.code === 404);
  await assert.rejects(f.getMetadata(), (e) => e.code === 404);
  await assert.rejects(f.delete(), (e) => e.code === 404);
  await f.delete({ ignoreNotFound: true });
  await f.save(Buffer.from("abc"), { metadata: { contentType: "image/jpeg", metadata: { by: "ada" } } });
  assert.deepEqual(await f.exists(), [true]);
  const [md] = await f.getMetadata();
  assert.deepEqual(md, { name: "p/a.jpg", size: "3", contentType: "image/jpeg", metadata: { by: "ada" } });
  assert.equal((await f.download())[0].toString(), "abc");
  assert.equal((await f.download({ start: 1, end: 1 }))[0].toString(), "b");
  assert.deepEqual(downloads, ["p/a.jpg", "p/a.jpg", "p/a.jpg"]);
  const soon = Date.now() + 60_000;
  const [url] = await f.getSignedUrl({ version: "v4", action: "read", expires: soon });
  assert.equal(url, "https://signed.example/p/a.jpg");
  assert.deepEqual(signed, [{ path: "p/a.jpg", opts: { version: "v4", action: "read", expires: soon } }]);
  await assert.rejects(f.getSignedUrl({ expires: soon }), /The action is not provided or invalid/);
  await assert.rejects(f.getSignedUrl({ action: "read" }), /The expiration date provided was invalid/);
  await assert.rejects(f.getSignedUrl({ action: "read", expires: Date.now() - 1000 }), /The expiration date provided was in the past/);
  await assert.rejects(f.getSignedUrl({ version: "v4", action: "read", expires: Date.now() + 8 * 86_400_000 }), /Max allowed expiration is seven days/);
  assert.equal(signed.length, 1); // a refused signing is not recorded
  assert.equal(files.get("p/a.jpg").contentType, "image/jpeg");
  await bucket.file("p/b.jpg").save(Buffer.from("x"));
  await bucket.file("q/c.jpg").save(Buffer.from("x"));
  await bucket.deleteFiles({ prefix: "p/" });
  assert.deepEqual([...files.keys()], ["q/c.jpg"]);
});

test("the bucket keeps a copy of the bytes it is handed", async () => {
  const { bucket } = createBucket();
  const bytes = Buffer.from("abc");
  await bucket.file("x").save(bytes);
  bytes[0] = 0x7a;
  assert.equal((await bucket.file("x").download())[0].toString(), "abc");
});

test("createFirebase hands back a database and a bucket together, in the shape firebase-admin tests use", async () => {
  const fb = createFirebase();
  for (const k of ["db", "bucket", "docs", "files", "signed", "downloads", "hooks"]) assert.ok(k in fb, k);
  assert.equal(fb.docs, fb.db.docs);
  assert.equal(fb.hooks, fb.db.hooks);
  await fb.db.doc("a/b").set({ x: 1 });
  assert.deepEqual(fb.docs.get("a/b"), { x: 1 });
});
