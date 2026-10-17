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
| Copies | Everything read is a copy; mutating it never edits the store |

Supported surface: `collection(path)`, `doc(path)`, `runTransaction(fn, opts)`; on a reference `get set update create delete collection parent`; on a query `where orderBy limit get count`; on a collection `doc() add()`; in a transaction `get(ref | query) getAll set update create delete`.

Test helpers that real Firestore does not have: `db.docs` (a `Map` of full path to data), `db.peek(path)` or `db.peek("coll", "id")`, `db.seed(path, data)`.

## Not modelled

Composite-index requirements, `Timestamp` conversion (a `Date` comes back a `Date`), `FieldValue` sentinels, contention and retries, listeners, batches. Each would be a welcome addition, with a test that fails without it.

## TypeScript

Types ship in `src/index.d.ts`. Code typed against `Firestore` takes the double with a cast: `createFirestore() as unknown as Firestore`.
