# Changelog

## 0.2.0

What two living templates (cofounders-template, first-years-template) had in a hand-copied double, brought in at this package's strictness so they can drop the copy (2026-10-17):

- Cursors: `startAt`, `startAfter`, `endAt`, `endBefore`, by field values or by a snapshot. Values count against the explicit `orderBy`s only, as the SDK counts them ("Too many cursor values specified"); a document-id value with a slash is refused.
- `FieldPath.documentId()` (any FieldPath) in `orderBy` and `where`.
- Implicit order: an inequality filter with no `orderBy` answers by that field ascending, and ties break by document id in the last `orderBy`'s direction (0.1.x always broke ties ascending, which Firestore does not).
- `select(...fields)`: projections, dotted paths keep their branch, `select()` keeps no fields.
- `db.batch()`: writes land together at commit or not at all; a committed batch refuses more.
- `db.getAll(...refs)`.
- Transactions run again when a document or query they read changed before commit, up to `maxAttempts` (default 5), then fail `10 ABORTED`. A callback that does not return a Promise is refused, as the SDK refuses it.
- `db.hooks.afterRead(path)`: runs after each document read, so a test can race a write against a read-modify-write.
- `createBucket()`: a Cloud Storage bucket double (save, download with a range, getMetadata, exists, delete, copy, getFiles, deleteFiles, getSignedUrl) that answers a missing object with 404 and refuses a signed URL with no action, a bad or past expiry, or a v4 expiry over seven days. Records `signed` and `downloads`.
- `createFirebase()`: the database and the bucket together as `{ db, bucket, docs, files, signed, downloads, hooks }`.

## 0.1.1

The first version on npm. Identical to 0.1.0, which npm refuses to publish: the registry holds a staged 0.1.0 that `npm stage list` does not show, and answers 409 "Cannot publish over previously staged version" (2026-10-17).

## 0.1.0

First release, extracted from the hand-rolled doubles in continental-works-web (`src/lib/suits.test.mjs`, `src/lib/operator-number.test.mjs`) and supersuit-room-host (`src/lib/rooms/memory-store.ts`), after two of them let a read-after-write transaction pass tests and fail in production (2026-10-15, 2026-10-17).
