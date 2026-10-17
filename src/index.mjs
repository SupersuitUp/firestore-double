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
// Since 0.2.0: a transaction whose reads changed before it committed runs again, up to maxAttempts
// (default 5, as the SDK), then fails ABORTED (code 10); an inequality filter orders by its field and
// ties break by id in the last orderBy's direction; cursors count against orderBy as the SDK counts
// them; a batch lands whole or not at all and cannot be committed twice; and the bucket double
// answers a missing object with 404 and refuses a signed URL the SDK would refuse.
//
// NOT modelled: composite-index requirements, Timestamp conversion (a Date comes back a Date,
// where Firestore returns a Timestamp), FieldValue sentinels, listeners, pessimistic locking (a
// conflicting write is modelled as a retry of the transaction, never as a wait).
import { isDeepStrictEqual } from "node:util";

/** firebase-admin's text, copied from @google-cloud/firestore build/src/transaction.js. */
export const READ_AFTER_WRITE = "Firestore transactions require all reads to be executed before all writes.";
export const READ_ONLY_WRITE = "Firestore read-only transactions cannot execute writes.";

export const CONTENTION = "Too much contention on these documents. Please try again.";
const NAME = "__name__"; // FieldPath.documentId()
const INEQUALITY = new Set(["<", "<=", ">", ">=", "!=", "not-in"]);

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
      get: () => readThrough(ref, docs.get(path)),
      set: async (data, opts) => { ops.set(docs, path, prepare(data), opts); return {}; },
      update: async (data) => { ops.update(docs, path, prepareUpdate(data)); return {}; },
      create: async (data) => { ops.create(docs, path, prepare(data)); return {}; },
      delete: async () => { ops.delete(docs, path); return {}; },
      isEqual: (other) => other?.path === path,
    };
    return ref;
  }

  // A field path is a string ("a.b") or a FieldPath; FieldPath.documentId() is "__name__".
  function fieldName(f) {
    if (typeof f === "string" && f !== "") return f;
    if (f && Array.isArray(f.segments) && f.segments.length) return f.segments.join(".");
    throw new Error(`Value for argument "fieldPath" is not a valid field path. Paths must be non-empty strings or FieldPath objects.`);
  }
  const idOf = (path) => path.slice(path.lastIndexOf("/") + 1);
  const valueAt = (path, data, f) => (f === NAME ? { has: true, value: idOf(path) } : fieldValue(data, f));
  function nameValue(v) {
    if (v && typeof v === "object" && typeof v.path === "string") return idOf(v.path);
    if (typeof v !== "string") throw new Error(`The corresponding value for FieldPath.documentId() must be a string or a DocumentReference, but was "${v}".`);
    if (v.includes("/")) throw new Error(`When querying a collection and ordering by FieldPath.documentId(), the corresponding value must be a plain document ID, but '${v}' contains a slash.`);
    return v;
  }
  // Firestore orders by the explicit orderBys, then every inequality field not already ordered
  // (lexicographically), then the document id, the implicit ones in the last explicit direction.
  function effectiveOrders(filters, orders) {
    const out = orders.slice();
    const have = new Set(out.map(([f]) => f));
    const dir = out.length ? out.at(-1)[1] : "asc";
    for (const f of [...new Set(filters.filter(([f, op]) => INEQUALITY.has(op) && f !== NAME).map(([f]) => f))].sort()) {
      if (!have.has(f)) { out.push([f, dir]); have.add(f); }
    }
    if (!have.has(NAME)) out.push([NAME, dir]);
    return out;
  }
  // Position of a row against a cursor, over the cursor's (prefix of the) orders.
  function position(path, data, cursor) {
    for (let i = 0; i < cursor.values.length; i++) {
      const [f, dir] = cursor.orders[i];
      const c = compare(valueAt(path, data, f).value, cursor.values[i]);
      if (c) return dir === "desc" ? -c : c;
    }
    return 0;
  }
  function project(data, fields) {
    const out = {};
    for (const f of fields) {
      if (f === NAME) continue;
      const { has, value } = fieldValue(data, f);
      if (has) setPath(out, f, clone(value));
    }
    return out;
  }

  function query(collPath, state = { filters: [], orders: [], lim: null, start: null, end: null, fields: null }) {
    const { filters, orders, lim, start, end, fields } = state;
    const next = (patch) => query(collPath, { ...state, ...patch });
    const depth = collPath.split("/").length + 1;
    const run = () => {
      let rows = [];
      for (const [path, data] of docs) {
        if (!path.startsWith(collPath + "/") || path.split("/").length !== depth) continue;
        rows.push([path, data]);
      }
      const all = effectiveOrders(filters, orders);
      rows = rows.filter(([p, d]) => filters.every(([f, op, x]) => { const { has, value } = valueAt(p, d, f); return has && MATCH[op](value, x); }));
      rows = rows.filter(([p, d]) => all.every(([f]) => valueAt(p, d, f).has));
      rows.sort(([pa, a], [pb, b]) => {
        for (const [f, dir] of all) {
          const c = compare(valueAt(pa, a, f).value, valueAt(pb, b, f).value);
          if (c) return dir === "desc" ? -c : c;
        }
        return 0;
      });
      if (start) rows = rows.filter(([p, d]) => { const c = position(p, d, start); return start.before ? c >= 0 : c > 0; });
      if (end) rows = rows.filter(([p, d]) => { const c = position(p, d, end); return end.before ? c < 0 : c <= 0; });
      if (lim !== null) rows = rows.slice(0, lim);
      const out = rows.map(([p, d]) => snapshot(docRef(p), fields ? project(d, fields) : d));
      return { docs: out, size: out.length, empty: out.length === 0, forEach: (fn) => out.forEach(fn) };
    };
    // As the SDK: field values count against the explicit orderBys only; a lone snapshot is read
    // through the implicit order too (inequality fields, then the document id).
    const cursor = (args, before) => {
      const snap = args.length === 1 && args[0] && typeof args[0] === "object" && "exists" in args[0] && typeof args[0].data === "function" && args[0].ref ? args[0] : null;
      let used, values;
      if (snap) {
        used = effectiveOrders(filters, orders);
        const data = snap.data();
        values = used.map(([f]) => {
          if (f === NAME) return snap.id;
          const got = fieldValue(data, f);
          if (!got.has) throw new Error(`Field "${f}" is missing in the provided DocumentSnapshot. Please provide a document that contains values for all specified orderBy() and where() constraints.`);
          return got.value;
        });
      } else {
        if (args.length > orders.length) throw new Error("Too many cursor values specified. The specified values must match the orderBy() constraints of the query.");
        used = orders;
        values = args.map((v, i) => {
          if (v === undefined) throw new Error(`Cannot use "undefined" as a Firestore value.`);
          return orders[i][0] === NAME ? nameValue(v) : v;
        });
      }
      return { orders: used, values, before };
    };
    return {
      where(field, op, value) {
        const f = fieldName(field);
        if (!MATCH[op]) throw new Error(`Invalid value for argument "opStr". Acceptable values are: ${Object.keys(MATCH).join(", ")}`);
        if (value === undefined) throw new Error(`Value for argument "value" is not a valid query constraint. Cannot use "undefined" as a Firestore value.`);
        if ((op === "in" || op === "not-in" || op === "array-contains-any") && !Array.isArray(value)) throw new Error(`Invalid Query. A non-empty array is required for '${op}' filters.`);
        if (f === NAME) value = Array.isArray(value) ? value.map(nameValue) : nameValue(value);
        return next({ filters: [...filters, [f, op, value]] });
      },
      orderBy(field, dir = "asc") {
        const f = fieldName(field);
        if (dir !== "asc" && dir !== "desc") throw new Error(`Invalid value for argument "directionStr". Acceptable values are: asc, desc`);
        if (start || end) throw new Error("Cannot specify an orderBy() constraint after calling startAt(), startAfter(), endBefore() or endAt().");
        return next({ orders: [...orders, [f, dir]] });
      },
      limit(n) {
        if (!Number.isInteger(n) || n < 0) throw new Error(`Value for argument "limit" is not a valid integer.`);
        return next({ lim: n });
      },
      startAt: (...v) => next({ start: cursor(v, true) }),
      startAfter: (...v) => next({ start: cursor(v, false) }),
      endBefore: (...v) => next({ end: cursor(v, true) }),
      endAt: (...v) => next({ end: cursor(v, false) }),
      select: (...fs) => next({ fields: fs.map(fieldName) }),
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

  // Every write lands, or (on a failed precondition) none does.
  function commit(writes) {
    const next = new Map(docs);
    for (const [op, path, data, setOpts] of writes) ops[op](next, path, data, setOpts);
    docs.clear();
    for (const [k, v] of next) docs.set(k, v);
  }
  const prepareFor = (op, data) => (op === "delete" ? undefined : op === "update" ? prepareUpdate(data) : prepare(data));

  function batch() {
    const writes = [];
    let committed = false;
    const guard = () => { if (committed) throw new Error("Cannot modify a WriteBatch that has already been committed."); };
    const write = (op) => (ref, data, setOpts) => { guard(); writes.push([op, ref.path, prepareFor(op, data), setOpts]); return b; };
    const b = {
      set: write("set"), update: write("update"), create: write("create"), delete: write("delete"),
      commit: async () => { guard(); committed = true; commit(writes); return []; },
    };
    return b;
  }

  async function runTransaction(fn, opts = {}) {
    const readOnly = !!opts.readOnly;
    const attempts = readOnly ? 1 : (opts.maxAttempts ?? 5);
    for (let attempt = 1; ; attempt++) {
      const writes = [];
      /** What each read saw, re-checked at commit: a function that answers whether it still holds. */
      const reads = [];
      const write = (op) => (ref, data, setOpts) => {
        if (readOnly) throw new Error(READ_ONLY_WRITE);
        writes.push([op, ref.path, prepareFor(op, data), setOpts]);
        return tx;
      };
      const readDoc = (ref) => {
        const seen = clone(docs.get(ref.path));
        reads.push(() => isDeepStrictEqual(docs.get(ref.path), seen));
        return readThrough(ref, seen);
      };
      const tx = {
        // Synchronous throw, as the SDK does: Transaction.get is not async.
        get(refOrQuery) {
          if (writes.length) throw new Error(READ_AFTER_WRITE);
          if (typeof refOrQuery?._run === "function") {
            const got = refOrQuery._run();
            const seen = got.docs.map((d) => [d.ref.path, d.data()]);
            reads.push(() => isDeepStrictEqual(refOrQuery._run().docs.map((d) => [d.ref.path, d.data()]), seen));
            return Promise.resolve(got);
          }
          return readDoc(refOrQuery);
        },
        getAll(...refs) {
          if (writes.length) throw new Error(READ_AFTER_WRITE);
          return Promise.all(refs.map(readDoc));
        },
        set: write("set"), update: write("update"), create: write("create"), delete: write("delete"),
      };
      const promise = fn(tx);
      if (!(promise instanceof Promise)) throw new Error("You must return a Promise in your transaction()-callback.");
      const result = await promise;
      if (!readOnly && !reads.every((holds) => holds())) {
        if (attempt < attempts) continue;
        throw grpcError(10, "ABORTED", CONTENTION);
      }
      commit(writes);
      return result;
    }
  }

  /** Test hooks. `afterRead(path)` runs after each document read (a get, a getAll, or one inside a transaction). */
  const hooks = {};
  // The snapshot is taken first, so a write made by the hook lands after the read, as a racing writer's would.
  async function readThrough(ref, data) {
    const s = snapshot(ref, clone(data));
    await hooks.afterRead?.(ref.path);
    return s;
  }

  const db = {
    collection: (path) => collectionRef(path),
    doc: (path) => docRef(path),
    getAll: (...refs) => Promise.all(refs.map((r) => r.get())),
    batch,
    runTransaction,
    hooks,
    /** Test helper: everything stored, keyed by full document path. */
    docs,
    /** Test helper: the stored data at a path, given whole ("a/b") or in segments ("a", "b"). */
    peek: (...parts) => clone(docs.get(parts.join("/"))),
    /** Test helper: put a document in place without going through validation. */
    seed: (path, data) => { segments(path, "document"); docs.set(path, clone(data)); },
  };
  return db;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIONS = new Set(["read", "write", "delete", "resumable"]);

/**
 * An in-memory stand-in for the slice of a Cloud Storage bucket (firebase-admin's getStorage().bucket())
 * that apps touch. A missing object answers 404 as the service does, a delete of one throws unless
 * `ignoreNotFound`, and getSignedUrl refuses what @google-cloud/storage refuses (no action, a bad or past
 * expiry, a v4 expiry beyond seven days). Signed URLs are `https://signed.example/<path>`.
 */
export function createBucket() {
  /** Test helper: every stored object by name. */
  const files = new Map();
  /** Test helper: every signing request that was granted, so a test can assert what a link carries. */
  const signed = [];
  /** Test helper: every download by name, so a test can assert bytes were (or were not) pulled. */
  const downloads = [];
  const missing = (name) => Object.assign(new Error(`No such object: ${name}`), { code: 404 });

  const file = (name) => ({
    name,
    exists: async () => [files.has(name)],
    save: async (bytes, o) => {
      files.set(name, { bytes: Buffer.from(bytes), contentType: o?.metadata?.contentType ?? o?.contentType, metadata: o?.metadata?.metadata ? { ...o.metadata.metadata } : undefined });
    },
    download: async (r) => {
      downloads.push(name);
      const f = files.get(name);
      if (!f) throw missing(name);
      if (r && (r.start !== undefined || r.end !== undefined)) return [Buffer.from(f.bytes.subarray(r.start ?? 0, (r.end ?? f.bytes.length - 1) + 1))];
      return [Buffer.from(f.bytes)];
    },
    getMetadata: async () => {
      const f = files.get(name);
      if (!f) throw missing(name);
      return [{ name, size: String(f.bytes.length), contentType: f.contentType, metadata: f.metadata ? { ...f.metadata } : undefined }];
    },
    delete: async (o) => { if (!files.delete(name) && !o?.ignoreNotFound) throw missing(name); return [{}]; },
    copy: async (dest) => {
      const f = files.get(name);
      if (!f) throw missing(name);
      const to = typeof dest === "string" ? dest : dest.name;
      files.set(to, { bytes: Buffer.from(f.bytes), contentType: f.contentType, metadata: f.metadata ? { ...f.metadata } : undefined });
    },
    getSignedUrl: async (opts = {}) => {
      if (!ACTIONS.has(opts.action)) throw new Error("The action is not provided or invalid.");
      const at = new Date(opts.expires).valueOf();
      if (opts.expires === undefined || Number.isNaN(at)) throw new Error("The expiration date provided was invalid.");
      if (at < Date.now()) throw new Error("The expiration date provided was in the past.");
      if (opts.version === "v4" && at - Date.now() > SEVEN_DAYS_MS) throw new Error("Max allowed expiration is seven days (604800 seconds).");
      signed.push({ path: name, opts });
      return [`https://signed.example/${name}`];
    },
  });

  const bucket = {
    file,
    getFiles: async (q = {}) => [[...files.keys()].filter((n) => n.startsWith(q.prefix ?? "")).map(file)],
    deleteFiles: async (q = {}) => { for (const n of [...files.keys()]) if (n.startsWith(q.prefix ?? "")) files.delete(n); },
  };
  return { bucket, files, signed, downloads };
}

/**
 * A database and a bucket together, in the shape app tests pass to a mocked firebase-admin module:
 * `{ db, bucket, docs, files, signed, downloads, hooks }`.
 * @param {{ ignoreUndefinedProperties?: boolean }} [settings]
 */
export function createFirebase(settings = {}) {
  const db = createFirestore(settings);
  const { bucket, files, signed, downloads } = createBucket();
  return { db, bucket, docs: db.docs, files, signed, downloads, hooks: db.hooks };
}
