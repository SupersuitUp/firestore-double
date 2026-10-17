# Changelog

## 0.1.1

The first version on npm. Identical to 0.1.0, which npm refuses to publish: the registry holds a staged 0.1.0 that `npm stage list` does not show, and answers 409 "Cannot publish over previously staged version" (2026-10-17).

## 0.1.0

First release, extracted from the hand-rolled doubles in continental-works-web (`src/lib/suits.test.mjs`, `src/lib/operator-number.test.mjs`) and supersuit-room-host (`src/lib/rooms/memory-store.ts`), after two of them let a read-after-write transaction pass tests and fail in production (2026-10-15, 2026-10-17).
