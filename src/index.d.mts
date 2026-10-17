// Types for @supersuit/firestore-double. The double is shaped like firebase-admin's Firestore, so
// production code typed against `Firestore` accepts it with a cast (`db as unknown as Firestore`).
export declare const READ_AFTER_WRITE: string
export declare const READ_ONLY_WRITE: string
export declare const CONTENTION: string

type Data = Record<string, any>
/** A field path: "a.b", or a FieldPath (FieldPath.documentId() orders and filters by id). */
type Field = string | { segments: string[] }

export interface DocumentSnapshot {
  id: string
  ref: DocumentReference
  exists: boolean
  data(): Data | undefined
  get(field: string): any
}
export interface QuerySnapshot {
  docs: DocumentSnapshot[]
  size: number
  empty: boolean
  forEach(fn: (d: DocumentSnapshot) => void): void
}
export interface Query {
  where(field: Field, op: string, value: unknown): Query
  orderBy(field: Field, dir?: 'asc' | 'desc'): Query
  limit(n: number): Query
  startAt(...values: unknown[]): Query
  startAfter(...values: unknown[]): Query
  endAt(...values: unknown[]): Query
  endBefore(...values: unknown[]): Query
  select(...fields: Field[]): Query
  get(): Promise<QuerySnapshot>
  count(): { get(): Promise<{ data(): { count: number } }> }
}
export interface DocumentReference {
  id: string
  path: string
  readonly parent: CollectionReference
  collection(sub: string): CollectionReference
  get(): Promise<DocumentSnapshot>
  set(data: Data, opts?: { merge?: boolean }): Promise<unknown>
  update(data: Data): Promise<unknown>
  create(data: Data): Promise<unknown>
  delete(): Promise<unknown>
  isEqual(other: DocumentReference): boolean
}
export interface CollectionReference extends Query {
  id: string
  path: string
  doc(id?: string): DocumentReference
  add(data: Data): Promise<DocumentReference>
}
export interface Transaction {
  get(ref: DocumentReference): Promise<DocumentSnapshot>
  get(query: Query): Promise<QuerySnapshot>
  getAll(...refs: DocumentReference[]): Promise<DocumentSnapshot[]>
  set(ref: DocumentReference, data: Data, opts?: { merge?: boolean }): Transaction
  update(ref: DocumentReference, data: Data): Transaction
  create(ref: DocumentReference, data: Data): Transaction
  delete(ref: DocumentReference): Transaction
}
export interface WriteBatch {
  set(ref: DocumentReference, data: Data, opts?: { merge?: boolean }): WriteBatch
  update(ref: DocumentReference, data: Data): WriteBatch
  create(ref: DocumentReference, data: Data): WriteBatch
  delete(ref: DocumentReference): WriteBatch
  commit(): Promise<unknown[]>
}
export interface FirestoreDouble {
  collection(path: string): CollectionReference
  doc(path: string): DocumentReference
  getAll(...refs: DocumentReference[]): Promise<DocumentSnapshot[]>
  batch(): WriteBatch
  runTransaction<T>(fn: (tx: Transaction) => Promise<T>, opts?: { readOnly?: boolean; maxAttempts?: number }): Promise<T>
  /** Test hooks: `afterRead(path)` runs after every document read, so a test can race a write against a read-modify-write. */
  hooks: { afterRead?: (path: string) => unknown }
  /** Test helper: every stored document, keyed by full path. */
  docs: Map<string, Data>
  /** Test helper: the stored data at a path ("a/b", or "a", "b"). */
  peek(...parts: string[]): Data | undefined
  /** Test helper: put a document in place without validation. */
  seed(path: string, data: Data): void
}
export declare function createFirestore(settings?: { ignoreUndefinedProperties?: boolean }): FirestoreDouble

export interface StoredFile { bytes: Buffer; contentType?: string; metadata?: Record<string, string> }
export interface FileDouble {
  name: string
  exists(): Promise<[boolean]>
  save(bytes: Uint8Array | string, opts?: { contentType?: string; metadata?: { contentType?: string; metadata?: Record<string, string> } }): Promise<void>
  download(range?: { start?: number; end?: number }): Promise<[Buffer]>
  getMetadata(): Promise<[{ name: string; size: string; contentType?: string; metadata?: Record<string, string> }]>
  delete(opts?: { ignoreNotFound?: boolean }): Promise<unknown>
  copy(dest: string | { name: string }): Promise<void>
  getSignedUrl(opts: { version?: string; action: 'read' | 'write' | 'delete' | 'resumable'; expires: number | string | Date; [k: string]: unknown }): Promise<[string]>
}
export interface BucketDouble {
  file(name: string): FileDouble
  getFiles(query?: { prefix?: string }): Promise<[FileDouble[]]>
  deleteFiles(query?: { prefix?: string }): Promise<void>
}
export interface BucketHandles {
  bucket: BucketDouble
  /** Test helper: every stored object by name. */
  files: Map<string, StoredFile>
  /** Test helper: every granted signing request. */
  signed: { path: string; opts: Record<string, unknown> }[]
  /** Test helper: every download by name. */
  downloads: string[]
}
export declare function createBucket(): BucketHandles
export declare function createFirebase(settings?: { ignoreUndefinedProperties?: boolean }): BucketHandles & {
  db: FirestoreDouble
  docs: Map<string, Data>
  hooks: FirestoreDouble['hooks']
}
