// Types for @supersuit/firestore-double. The double is shaped like firebase-admin's Firestore, so
// production code typed against `Firestore` accepts it with a cast (`db as unknown as Firestore`).
export declare const READ_AFTER_WRITE: string
export declare const READ_ONLY_WRITE: string

type Data = Record<string, any>

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
  where(field: string, op: string, value: unknown): Query
  orderBy(field: string, dir?: 'asc' | 'desc'): Query
  limit(n: number): Query
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
export interface FirestoreDouble {
  collection(path: string): CollectionReference
  doc(path: string): DocumentReference
  runTransaction<T>(fn: (tx: Transaction) => Promise<T>, opts?: { readOnly?: boolean }): Promise<T>
  /** Test helper: every stored document, keyed by full path. */
  docs: Map<string, Data>
  /** Test helper: the stored data at a path ("a/b", or "a", "b"). */
  peek(...parts: string[]): Data | undefined
  /** Test helper: put a document in place without validation. */
  seed(path: string, data: Data): void
}
export declare function createFirestore(settings?: { ignoreUndefinedProperties?: boolean }): FirestoreDouble
