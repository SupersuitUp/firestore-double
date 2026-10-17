// Each test here is one rule Firestore enforces in production. A double that drops any of them
// lets a test pass that production fails, which is the whole reason this package exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirestore, READ_AFTER_WRITE } from "../src/index.mjs";

test("a transaction that reads after writing throws Firestore's own message, and writes nothing", async () => {
  const db = createFirestore();
  const a = db.collection("suits").doc("a"), b = db.collection("suits").doc("b");
  await assert.rejects(db.runTransaction(async (tx) => { tx.set(a, { x: 1 }); await tx.get(b); }), { message: READ_AFTER_WRITE });
  assert.equal(READ_AFTER_WRITE, "Firestore transactions require all reads to be executed before all writes.");
  assert.equal(db.peek("suits/a"), undefined);
});

test("the read-after-write throw is synchronous, as the SDK's Transaction.get is", async () => {
  const db = createFirestore();
  await db.runTransaction(async (tx) => {
    tx.set(db.doc("a/1"), { x: 1 });
    assert.throws(() => tx.get(db.doc("a/2")), { message: READ_AFTER_WRITE });
    assert.throws(() => tx.get(db.collection("a").where("x", "==", 1)), { message: READ_AFTER_WRITE });
    assert.throws(() => tx.getAll(db.doc("a/2")), { message: READ_AFTER_WRITE });
  }).catch(() => {});
});

test("reads first, then writes, commits; a transaction's writes are invisible until it returns", async () => {
  const db = createFirestore();
  const ref = db.doc("counters/n");
  await ref.set({ next: 1 });
  const out = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    tx.set(ref, { next: s.data().next + 1 });
    assert.equal(db.peek("counters/n").next, 1);
    return s.data().next;
  });
  assert.equal(out, 1);
  assert.equal(db.peek("counters", "n").next, 2);
});

test("a transaction that throws applies nothing, and a failed precondition at commit applies nothing either", async () => {
  const db = createFirestore();
  await db.runTransaction(async (tx) => { tx.set(db.doc("a/1"), { x: 1 }); throw new Error("no"); }).catch(() => {});
  assert.equal(db.peek("a/1"), undefined);
  await assert.rejects(db.runTransaction(async (tx) => { tx.set(db.doc("a/2"), { x: 2 }); tx.update(db.doc("a/missing"), { x: 3 }); }), { code: 5 });
  assert.equal(db.peek("a/2"), undefined);
});

test("update() of a missing document is 5 NOT_FOUND; create() of an existing one is 6 ALREADY_EXISTS", async () => {
  const db = createFirestore();
  await assert.rejects(db.doc("a/1").update({ x: 1 }), (e) => e.code === 5 && /NOT_FOUND: No document to update: a\/1/.test(e.message));
  await db.doc("a/1").create({ x: 1 });
  await assert.rejects(db.doc("a/1").create({ x: 2 }), (e) => e.code === 6 && /ALREADY_EXISTS/.test(e.message));
  await assert.rejects(db.runTransaction(async (tx) => { tx.create(db.doc("a/1"), { x: 3 }); }), { code: 6 });
  assert.equal(db.peek("a/1").x, 1);
});

test("undefined in written data is refused unless ignoreUndefinedProperties is on, which drops it", async () => {
  const db = createFirestore();
  await assert.rejects(db.doc("a/1").set({ x: 1, y: { z: undefined } }), /Cannot use "undefined" as a Firestore value \(found in field "y.z"\)/);
  await assert.rejects(db.runTransaction(async (tx) => { tx.set(db.doc("a/1"), { y: undefined }); }), /undefined/);
  assert.throws(() => db.collection("a").where("x", "==", undefined), /undefined/);
  const lax = createFirestore({ ignoreUndefinedProperties: true });
  await lax.doc("a/1").set({ x: 1, y: undefined });
  assert.deepEqual(lax.peek("a/1"), { x: 1 });
});

test("set replaces, set with merge deep-merges, update replaces a field and follows dotted paths", async () => {
  const db = createFirestore();
  const ref = db.doc("a/1");
  await ref.set({ m: { p: 1, q: 2 }, keep: true });
  await ref.set({ m: { q: 3 } }, { merge: true });
  assert.deepEqual(db.peek("a/1"), { m: { p: 1, q: 3 }, keep: true });
  await ref.update({ "m.p": 9 });
  assert.deepEqual(db.peek("a/1").m, { p: 9, q: 3 });
  await ref.update({ m: { r: 1 } });
  assert.deepEqual(db.peek("a/1").m, { r: 1 });
  await ref.set({ only: 1 });
  assert.deepEqual(db.peek("a/1"), { only: 1 });
  await assert.rejects(ref.update({}), /At least one field/);
});

test("a read-only transaction refuses writes", async () => {
  const db = createFirestore();
  await assert.rejects(db.runTransaction(async (tx) => { tx.set(db.doc("a/1"), { x: 1 }); }, { readOnly: true }), /read-only transactions cannot execute writes/);
});

test("results are copies: mutating what you read never edits the store", async () => {
  const db = createFirestore();
  const input = { list: [1], m: { a: 1 } };
  await db.doc("a/1").set(input);
  input.list.push(2);
  const snap = await db.doc("a/1").get();
  snap.data().m.a = 99;
  assert.deepEqual(db.peek("a/1"), { list: [1], m: { a: 1 } });
});

test("paths must have the right parity, as Firestore requires", () => {
  const db = createFirestore();
  assert.throws(() => db.doc("a"), /must point to a document/);
  assert.throws(() => db.collection("a/b"), /must point to a collection/);
  assert.throws(() => db.doc("a//b"), /not a valid resource path/);
  assert.equal(db.collection("rooms").doc("r1").collection("members").doc("m1").path, "rooms/r1/members/m1");
});

test("queries: filters and orderBy drop documents lacking the field; default order is by id; limit applies last", async () => {
  const db = createFirestore();
  const c = db.collection("events");
  await c.doc("c").set({ at: 3, kind: "x", tags: ["a"] });
  await c.doc("a").set({ at: 1, kind: "y", tags: ["b"] });
  await c.doc("b").set({ at: 2, kind: "x" });
  await c.doc("d").set({ kind: "x" });
  await db.doc("events/a/sub/z").set({ at: 0, kind: "x" }); // a subcollection is not part of the query
  const ids = async (q) => (await q.get()).docs.map((d) => d.id);
  assert.deepEqual(await ids(c), ["a", "b", "c", "d"]);
  assert.deepEqual(await ids(c.where("kind", "==", "x")), ["b", "c", "d"]);
  assert.deepEqual(await ids(c.where("at", ">", 1)), ["b", "c"]);
  assert.deepEqual(await ids(c.where("at", ">", "1")), []); // range filters match their own type only
  assert.deepEqual(await ids(c.orderBy("at", "desc")), ["c", "b", "a"]);
  assert.deepEqual(await ids(c.where("kind", "==", "x").orderBy("at").limit(1)), ["b"]);
  assert.deepEqual(await ids(c.where("tags", "array-contains", "a")), ["c"]);
  assert.deepEqual(await ids(c.where("kind", "in", ["y"])), ["a"]);
  assert.deepEqual(await ids(c.where("at", "!=", 1)), ["b", "c"]);
  const snap = await c.where("kind", "==", "nope").get();
  assert.equal(snap.empty, true);
  assert.equal(snap.size, 0);
  assert.equal((await c.count().get()).data().count, 4);
});

test("a transaction can read a query, and add() mints an id that create() guards", async () => {
  const db = createFirestore();
  const ref = await db.collection("invites").add({ code: "z" });
  assert.equal(ref.id.length, 20);
  const n = await db.runTransaction(async (tx) => (await tx.get(db.collection("invites").where("code", "==", "z"))).size);
  assert.equal(n, 1);
});
