# @supersuit/firestore-double

An in-memory Firestore for tests that refuses what production refuses: reads after writes in a transaction, updates of missing documents, undefined values.

A test double is only worth having if it is at least as strict as the thing it stands in for. A hand-rolled one is usually laxer, and then the tests pass and production fails. This one is shaped like `firebase-admin`'s `Firestore`, so the code under test runs unchanged, and it throws Firestore's own errors where Firestore would.

## 30 seconds

```bash
npm i -D @supersuit/firestore-double
```

```js
import { createFirestore } from "@supersuit/firestore-double";

const db = createFirestore();               // hand it wherever your code takes a Firestore
await db.collection("accounts").doc("a").set({ email: "a@x" });

await db.runTransaction(async (tx) => {
  tx.set(db.doc("accounts/b"), { email: "b@x" });
  await tx.get(db.doc("accounts/a"));       // throws, exactly as production does:
});                                         // "Firestore transactions require all reads to be executed before all writes."

db.peek("accounts/a");                      // test helper: the stored data
```

## What it enforces

| Rule | What you get |
| --- | --- |
| Reads before writes in a transaction | `Firestore transactions require all reads to be executed before all writes.` (synchronous, like the SDK) |
| Transaction writes are atomic | Nothing lands if the function throws or a precondition fails at commit |
| `update()` needs the document | `5 NOT_FOUND: No document to update: <path>`, `err.code === 5` |
| `create()` needs it absent | `6 ALREADY_EXISTS: Document already exists: <path>`, `err.code === 6` |
| No `undefined` in data | Refused, unless `createFirestore({ ignoreUndefinedProperties: true })`, which drops it as Firestore does |
| Read-only transactions | `runTransaction(fn, { readOnly: true })` refuses writes |
| Path parity | `doc()` needs an even path, `collection()` an odd one |
| Queries | `where` (`== != < <= > >= in not-in array-contains array-contains-any`) and `orderBy` drop documents lacking the field; range filters match their own type only; default order is by document id |
| Cursors | `startAt startAfter endAt endBefore` take field values (no more than the explicit `orderBy`s, or `Too many cursor values specified`) or a snapshot |
| Implicit order | An inequality filter orders by its field; ties break by document id in the last `orderBy`'s direction |
| Contention | A transaction whose reads changed before commit runs again, up to `maxAttempts` (default 5), then fails `10 ABORTED` |
| Batches | `batch()` lands whole or not at all; a committed batch refuses more |
| Copies | Everything read is a copy; mutating it never edits the store |

Supported surface: `collection(path)`, `doc(path)`, `getAll(...refs)`, `batch()`, `runTransaction(fn, { readOnly, maxAttempts })`; on a reference `get set update create delete collection parent`; on a query `where orderBy limit startAt startAfter endAt endBefore select get count` (fields as strings or `FieldPath`, including `FieldPath.documentId()`); on a collection `doc() add()`; in a transaction `get(ref | query) getAll set update create delete`.

Test helpers that real Firestore does not have: `db.docs` (a `Map` of full path to data), `db.peek(path)` or `db.peek("coll", "id")`, `db.seed(path, data)`, and `db.hooks.afterRead = (path) => ...`, which runs after every document read so a test can slip a write in between a transaction's read and its commit.

## The bucket

```js
import { createBucket, createFirebase } from "@supersuit/firestore-double";

const { bucket, files, signed, downloads } = createBucket();
// or both at once, in the shape a mocked firebase-admin module hands out:
const fb = createFirebase(); // { db, bucket, docs, files, signed, downloads, hooks }
vi.mock("@/lib/firebase-admin", () => ({ getAdminDb: () => fb.db, getAdminBucket: () => fb.bucket }));
```

`bucket.file(name)` has `exists save download getMetadata delete copy getSignedUrl`; the bucket has `getFiles deleteFiles` by prefix. A missing object answers `code: 404`, `delete()` of one throws unless `{ ignoreNotFound: true }`, and `getSignedUrl` refuses no action, a bad or past expiry, and a v4 expiry over seven days, as `@google-cloud/storage` does. Signed URLs are `https://signed.example/<name>`; `signed` records every granted request and `downloads` every download.

## Not modelled

Composite-index requirements, `Timestamp` conversion (a `Date` comes back a `Date`), `FieldValue` sentinels, listeners, and pessimistic locking (a conflicting write is modelled as a retry, never a wait). Each would be a welcome addition, with a test that fails without it.

## TypeScript

Types ship in `src/index.d.mts`. Code typed against `Firestore` takes the double with a cast: `createFirestore() as unknown as Firestore`.
