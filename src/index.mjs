// @supersuit/firestore-double: an in-memory stand-in for firebase-admin's Firestore, for tests.
//
// WHY IT EXISTS. Twice in three days a hand-rolled double was laxer than Firestore, the tests
// passed, and production failed: Supersuit Rooms' retireMember (2026-10-15) and the account
// server's registerSuit (2026-10-17) both read inside a transaction after writing, which
// Firestore refuses. A double is only worth having if it refuses what production refuses, so
// every rule below is one Firestore enforces, with Firestore's own error text where a caller
// might match on it.
//
// Enforced: reads before writes in a transaction (the SDK's exact message), transaction writes
// landing together or not at all, update() of a missing document (5 NOT_FOUND), create() of an
// existing one (6 ALREADY_EXISTS), undefined anywhere in written data (unless the caller opts
// into ignoreUndefinedProperties, as Firestore does), writes inside a readOnly transaction,
// document and collection paths of the right parity, and query filters and orderBy dropping
// documents that lack the field. Results are copies, so mutating one never edits the store.
//
// NOT modelled: composite-index requirements, Timestamp conversion (a Date comes back a Date,
// where Firestore returns a Timestamp), FieldValue sentinels, contention and retries, listeners.
import { isDeepStrictEqual } from "node:util";

/** firebase-admin's text, copied from @google-cloud/firestore build/src/transaction.js. */
export const READ_AFTER_WRITE = "Firestore transactions require all reads to be executed before all writes.";
export const READ_ONLY_WRITE = "Firestore read-only transactions cannot execute writes.";

const AUTO_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const autoId = () => Array.from({ length: 20 }, () => AUTO_ID[Math.floor(Math.random() * AUTO_ID.length)]).join("");

const isPlain = (v) => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function grpcError(code, status, message) {
  const e = new Error(`${code} ${status}: ${message}`);
  e.code = code;
  e.details = message;
  return e;
}

function segments(path, kind) {
  if (typeof path !== "string" || path === "") throw new Error(`Value for argument "${kind}Path" is not a valid resource path. Path must be a non-empty string.`);
  const parts = path.split("/");
  if (parts.some((p) => p === "")) throw new Error(`Value for argument "${kind}Path" is not a valid resource path. Paths must not contain //.`);
  const wantOdd = kind === "collection";
  if ((parts.length % 2 === 1) !== wantOdd) {
    throw new Error(`Value for argument "${kind}Path" must point to a ${kind}, but was "${path}". Your path does not contain an ${wantOdd ? "odd" : "even"} number of components.`);
  }
  return parts;
}

function fieldValue(data, field) {
  let cur = data;
  for (const k of field.split(".")) {
    if (!isPlain(cur) || !(k in cur)) return { has: false };
    cur = cur[k];
  }
  return { has: true, value: cur };
}

function validate(data, ignoreUndefined, where = "") {
  if (!isPlain(data)) throw new Error(`Value for argument "data" is not a valid Firestore document. Input is not a plain JavaScript object.`);
  const walk = (v, at) => {
    if (v === undefined) {
      if (ignoreUndefined) return;
      throw new Error(`Value for argument "data" is not a valid Firestore document. Cannot use "undefined" as a Firestore value (found in field "${at}"). If you want to ignore undefined values, enable \`ignoreUndefinedProperties\`.`);
    }
    if (typeof v === "function" || typeof v === "symbol") throw new Error(`Value for argument "data" is not a valid Firestore document. Couldn't serialize object of type "${typeof v}" (found in field "${at}").`);
    if (Array.isArray(v)) v.forEach((x, i) => { if (Array.isArray(x)) throw new Error(`Value for argument "data" is not a valid Firestore document. Cannot use nested arrays (found in field "${at}.${i}").`); walk(x, at); });
    else if (isPlain(v)) for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k);
  };
  for (const [k, v] of Object.entries(data)) walk(v, where ? `${where}.${k}` : k);
}

function strip(v) {
  // With ignoreUndefinedProperties, Firestore drops the field rather than storing it.
  if (Array.isArray(v)) return v.filter((x) => x !== undefined).map(strip);
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, strip(x)]));
  return v;
}

function deepMerge(base, patch) {
  const out = isPlain(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

function setPath(obj, field, value) {
  const keys = field.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) { if (!isPlain(cur[k])) cur[k] = {}; cur = cur[k]; }
  cur[keys.at(-1)] = value;
}

// Firestore orders values of different types by type first; within a type, by value.
const TYPE_ORDER = (v) => v === null ? 0 : typeof v === "boolean" ? 1 : typeof v === "number" ? 2 : v instanceof Date ? 3 : typeof v === "string" ? 4 : Array.isArray(v) ? 6 : 7;
function compare(a, b) {
  const ta = TYPE_ORDER(a), tb = TYPE_ORDER(b);
  if (ta !== tb) return ta - tb;
  if (a instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" || typeof a === "string" || typeof a === "boolean") return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}
const sameType = (a, b) => TYPE_ORDER(a) === TYPE_ORDER(b);

const MATCH = {
  "==": (v, x) => isDeepStrictEqual(v, x),
  "!=": (v, x) => v !== null && !isDeepStrictEqual(v, x),
  "<": (v, x) => sameType(v, x) && compare(v, x) < 0,
  "<=": (v, x) => sameType(v, x) && compare(v, x) <= 0,
  ">": (v, x) => sameType(v, x) && compare(v, x) > 0,
  ">=": (v, x) => sameType(v, x) && compare(v, x) >= 0,
  "in": (v, xs) => xs.some((x) => isDeepStrictEqual(v, x)),
  "not-in": (v, xs) => v !== null && !xs.some((x) => isDeepStrictEqual(v, x)),
  "array-contains": (v, x) => Array.isArray(v) && v.some((e) => isDeepStrictEqual(e, x)),
  "array-contains-any": (v, xs) => Array.isArray(v) && v.some((e) => xs.some((x) => isDeepStrictEqual(e, x))),
};

/**
 * A fresh, empty in-memory Firestore shaped like firebase-admin's.
 * @param {{ ignoreUndefinedProperties?: boolean }} [settings]
 */
export function createFirestore(settings = {}) {
  const ignoreUndefined = !!settings.ignoreUndefinedProperties;
  /** Every document, keyed by its full path ("rooms/r1/members/m1"). Tests may read and seed it. */
  const docs = new Map();

  const prepare = (data) => { validate(data, ignoreUndefined); return clone(ignoreUndefined ? strip(data) : data); };

  function snapshot(ref, data) {
    return {
      id: ref.id, ref, exists: data !== undefined,
      data: () => clone(data),
      get: (field) => (data === undefined ? undefined : clone(fieldValue(data, field).value)),
    };
  }

  // Write operations as pure functions of a document map, so a transaction can run them on a copy.
  const ops = {
    set(map, path, data, opts) { map.set(path, opts?.merge ? deepMerge(map.get(path), data) : data); },
    update(map, path, data) {
      if (!map.has(path)) throw grpcError(5, "NOT_FOUND", `No document to update: ${path}`);
      const next = structuredClone(map.get(path));
      for (const [k, v] of Object.entries(data)) setPath(next, k, v);
      map.set(path, next);
    },
    create(map, path, data) {
      if (map.has(path)) throw grpcError(6, "ALREADY_EXISTS", `Document already exists: ${path}`);
      map.set(path, data);
    },
    delete(map, path) { map.delete(path); },
  };
  function prepareUpdate(data) {
    if (!isPlain(data) || Object.keys(data).length === 0) throw new Error("At least one field must be updated.");
    validate(data, ignoreUndefined);
    return clone(ignoreUndefined ? strip(data) : data);
  }

  function docRef(path) {
    const parts = segments(path, "document");
    const ref = {
      id: parts.at(-1), path, firestore: db,
      get parent() { return collectionRef(parts.slice(0, -1).join("/")); },
      collection: (sub) => collectionRef(`${path}/${sub}`),
      get: async () => snapshot(ref, docs.get(path)),
      set: async (data, opts) => { ops.set(docs, path, prepare(data), opts); return {}; },
      update: async (data) => { ops.update(docs, path, prepareUpdate(data)); return {}; },
      create: async (data) => { ops.create(docs, path, prepare(data)); return {}; },
      delete: async () => { ops.delete(docs, path); return {}; },
      isEqual: (other) => other?.path === path,
    };
    return ref;
  }

  function query(collPath, filters = [], orders = [], lim = null) {
    const depth = collPath.split("/").length + 1;
    const run = () => {
      let rows = [];
      for (const [path, data] of docs) {
        if (!path.startsWith(collPath + "/") || path.split("/").length !== depth) continue;
        rows.push([path, data]);
      }
      rows = rows.filter(([, d]) => filters.every(([f, op, x]) => { const { has, value } = fieldValue(d, f); return has && MATCH[op](value, x); }));
      rows = rows.filter(([, d]) => orders.every(([f]) => fieldValue(d, f).has));
      rows.sort(([pa, a], [pb, b]) => {
        for (const [f, dir] of orders) {
          const c = compare(fieldValue(a, f).value, fieldValue(b, f).value);
          if (c) return dir === "desc" ? -c : c;
        }
        return pa < pb ? -1 : pa > pb ? 1 : 0; // then by document id, as Firestore does
      });
      if (lim !== null) rows = rows.slice(0, lim);
      const out = rows.map(([p, d]) => snapshot(docRef(p), d));
      return { docs: out, size: out.length, empty: out.length === 0, forEach: (fn) => out.forEach(fn) };
    };
    return {
      where(field, op, value) {
        if (!MATCH[op]) throw new Error(`Invalid value for argument "opStr". Acceptable values are: ${Object.keys(MATCH).join(", ")}`);
        if (value === undefined) throw new Error(`Value for argument "value" is not a valid query constraint. Cannot use "undefined" as a Firestore value.`);
        if ((op === "in" || op === "not-in" || op === "array-contains-any") && !Array.isArray(value)) throw new Error(`Invalid Query. A non-empty array is required for '${op}' filters.`);
        return query(collPath, [...filters, [field, op, value]], orders, lim);
      },
      orderBy(field, dir = "asc") {
        if (dir !== "asc" && dir !== "desc") throw new Error(`Invalid value for argument "directionStr". Acceptable values are: asc, desc`);
        return query(collPath, filters, [...orders, [field, dir]], lim);
      },
      limit(n) { return query(collPath, filters, orders, n); },
      get: async () => run(),
      count: () => ({ get: async () => { const n = run().size; return { data: () => ({ count: n }) }; } }),
      _run: run,
    };
  }

  function collectionRef(path) {
    const parts = segments(path, "collection");
    return {
      ...query(path),
      id: parts.at(-1), path, firestore: db,
      doc: (id) => docRef(`${path}/${id === undefined ? autoId() : id}`),
      add: async (data) => { const ref = docRef(`${path}/${autoId()}`); await ref.create(data); return ref; },
    };
  }

  async function runTransaction(fn, opts = {}) {
    const writes = [];
    const readOnly = !!opts.readOnly;
    const write = (op) => (ref, data, setOpts) => {
      if (readOnly) throw new Error(READ_ONLY_WRITE);
      const prepared = op === "delete" ? undefined : op === "update" ? prepareUpdate(data) : prepare(data);
      writes.push([op, ref.path, prepared, setOpts]);
      return tx;
    };
    const tx = {
      // Synchronous throw, as the SDK does: Transaction.get is not async.
      get(refOrQuery) {
        if (writes.length) throw new Error(READ_AFTER_WRITE);
        if (typeof refOrQuery?._run === "function") return Promise.resolve(refOrQuery._run());
        return refOrQuery.get();
      },
      getAll(...refs) {
        if (writes.length) throw new Error(READ_AFTER_WRITE);
        return Promise.all(refs.map((r) => r.get()));
      },
      set: write("set"), update: write("update"), create: write("create"), delete: write("delete"),
    };
    const result = await fn(tx);
    // Commit: every write lands, or (on a failed precondition) none does.
    const next = new Map(docs);
    for (const [op, path, data, setOpts] of writes) ops[op](next, path, data, setOpts);
    docs.clear();
    for (const [k, v] of next) docs.set(k, v);
    return result;
  }

  const db = {
    collection: (path) => collectionRef(path),
    doc: (path) => docRef(path),
    runTransaction,
    /** Test helper: everything stored, keyed by full document path. */
    docs,
    /** Test helper: the stored data at a path, given whole ("a/b") or in segments ("a", "b"). */
    peek: (...parts) => clone(docs.get(parts.join("/"))),
    /** Test helper: put a document in place without going through validation. */
    seed: (path, data) => { segments(path, "document"); docs.set(path, clone(data)); },
  };
  return db;
}
