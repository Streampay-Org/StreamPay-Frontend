import { makeDemoDateShifter } from "@/app/lib/demo-dates";
import type {
  AppendOnlyStore,
  ExportAuditRecord,
  ExportRepository,
  IdempotencyStore,
  KeyValueStore,
  PersistenceStore,
  StreamRepository,
} from "@/app/lib/db";
import type { ActivityEvent, ExportJob, Stream, User } from "@/app/types/openapi";
import { createActivityTimelineStore, type ActivityTimelineStore, activityEventToTimelineEntry } from "@/app/lib/repositories/activity-timeline";
import { createStreamHistoryStore } from "@/app/lib/repositories/stream-history";

// Keep seeded demo timestamps recent (no-op under Jest).
const demoDate = makeDemoDateShifter("2026-04-28T12:00:00Z");

// ---------------------------------------------------------------------------
// Test-fixture seed data — all values are synthetic and carry no real
// credentials, PII, or secrets. Flagged by static analysis as
// "hardcoded credentials" due to field names; annotation here confirms
// these are intentional, non-sensitive development fixtures only.
// ---------------------------------------------------------------------------

/* test-fixture */ const initialUsers: User[] = [
  {
    wallet_address: "GD7H...3J4K", // synthetic truncated placeholder
    email: "fixture-user-1@example.test", // non-real domain
    display_name: "Ada Creative",
    avatar_url: null,
    created_at: demoDate("2026-01-01T00:00:00Z"),
    last_seen: null,
  },
];

/* test-fixture */ const initialStreams: Stream[] = [
  {
    id: "stream-ada",
    recipient: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7G",
    rate: "120 XLM / month",
    schedule: "Pays every 30 days",
    status: "active",
    nextAction: "pause",
    createdAt: demoDate("2026-04-01T09:00:00Z"),
    updatedAt: demoDate("2026-04-28T10:30:00Z"),
    email: "fixture-user-1@example.test", // non-real domain
    label: "Design Retainer Q2",
    partnerId: "PARTNER-FIXTURE-1", // synthetic partner id
    token: "XLM",
    settlementTxHash:
      "c3f8a12e4b76d09e1a23f456bc78d90e1f234a5678b9c0d1e2f3a4b5c6d7e8f9",
    totalAmount: "3600000000",
    vestedAmount: "1800000000",
    releasedAmount: "1200000000",
    senderAddress: "GSENDER00000000000000000000000000000000000000000000",
    ownership: "org",
  },
  {
    id: "stream-kemi",
    recipient: "GBVZZ5QKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2Z",
    rate: "32 XLM / week",
    schedule: "Draft stream ready to launch",
    status: "draft",
    nextAction: "start",
    label: "Kemi Onboarding Support",
    createdAt: demoDate("2026-04-10T14:00:00Z"),
    updatedAt: demoDate("2026-04-28T11:00:00Z"),
    email: "fixture-user-2@example.test", // non-real domain
    memo: "April Support batch",
    token: "XLM",
    totalAmount: "1280000000",
    vestedAmount: "0",
    releasedAmount: "0",
    senderAddress: "GSENDER00000000000000000000000000000000000000000000",
    ownership: "individual",
  },
  {
    id: "stream-yusuf",
    recipient: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGYWDEAVQBMJ87WGNB55IAA",
    rate: "18 XLM / day",
    schedule: "Ended yesterday with funds available",
    status: "ended",
    nextAction: "withdraw",
    label: "Yusuf QA Partnership",
    createdAt: demoDate("2026-04-15T08:00:00Z"),
    updatedAt: demoDate("2026-04-27T20:00:00Z"),
    token: "XLM",
    settlementTxHash:
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    withdrawal: {
      state: "pending",
      requestedAt: demoDate("2026-04-27T20:15:00Z"),
      lastCheckedAt: demoDate("2026-04-27T20:20:00Z"),
      attempts: 1,
    },
    totalAmount: "540000000",
    vestedAmount: "540000000",
    releasedAmount: "0",
    senderAddress: "GSENDER00000000000000000000000000000000000000000000",
    ownership: "individual",
  },
  {
    id: "stream-unclaimed",
    recipient: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGYWDEAVQBMJ87WGNB55IAA",
    rate: "10 XLM / day",
    schedule: "Legacy unclaimed stream",
    status: "active",
    nextAction: "pause",
    label: "Legacy Unclaimed Stream",
    createdAt: demoDate("2026-04-12T08:00:00Z"),
    updatedAt: demoDate("2026-04-20T10:00:00Z"),
    token: "XLM",
    totalAmount: "1000000000",
    vestedAmount: "500000000",
    releasedAmount: "0",
    senderAddress: null,
    ownership: "unclaimed",
  },
];

const initialActivity: ActivityEvent[] = [
  {
    id: "a7383234-4224-49dc-b868-0cdf37649fda",
    type: "wallet.connected",
    timestamp: demoDate("2026-04-28T09:00:00Z"),
    description: "Wallet connected and authenticated.",
  },
  {
    id: "2b9d1d0c-bef4-46bc-a783-3073b28353fc",
    type: "stream.created",
    streamId: "stream-ada",
    timestamp: demoDate("2026-04-01T09:00:00Z"),
    description: "Stream 'Design Retainer' created and set to draft.",
  },
  {
    id: "d1578871-4be9-4c6a-bef5-12b2b5836478",
    type: "stream.started",
    streamId: "stream-ada",
    timestamp: demoDate("2026-04-01T09:05:00Z"),
    description: "Stream 'Design Retainer' activated.",
  },
  {
    id: "288f315d-5520-46e9-8acf-96994c87b786",
    type: "stream.created",
    streamId: "stream-kemi",
    timestamp: demoDate("2026-04-10T14:00:00Z"),
    description: "Stream 'Kemi Onboarding Support' created as draft.",
  },
  {
    id: "3bea183d-c3b5-4e96-9fbe-804f3aee49e9",
    type: "stream.created",
    streamId: "stream-yusuf",
    timestamp: demoDate("2026-04-15T08:00:00Z"),
    description: "Stream 'Yusuf QA Partnership' created.",
  },
  {
    id: "5ffa85da-27a4-4f7c-bde0-e5c067a28015",
    type: "stream.stopped",
    streamId: "stream-yusuf",
    timestamp: demoDate("2026-04-27T20:00:00Z"),
    description: "Stream 'Yusuf QA Partnership' stopped and settled automatically.",
  },
];

function createUsersMap(): Map<string, User> {
  return new Map(initialUsers.map((user) => [user.wallet_address, { ...user }]));
}

function createStreamsMap(): Map<string, Stream> {
  return new Map(initialStreams.map((stream) => [stream.id, { ...stream }]));
}

function createActivityMap(): Map<string, ActivityEvent> {
  return new Map(initialActivity.map((event) => [event.id, { ...event }]));
}

class InMemoryKeyValueStore<K, V> implements KeyValueStore<K, V> {
  constructor(private readonly backing: Map<K, V>) {}

  get size(): number {
    return this.backing.size;
  }

  clear(): void {
    this.backing.clear();
  }

  delete(key: K): boolean {
    return this.backing.delete(key);
  }

  entries(): IterableIterator<[K, V]> {
    return this.backing.entries();
  }

  forEach(callbackfn: (value: V, key: K) => void): void {
    this.backing.forEach((value, key) => callbackfn(value, key));
  }

  get(key: K): V | undefined {
    return this.backing.get(key);
  }

  insert(key: K, value: V): boolean {
    if (this.backing.has(key)) {
      return false;
    }
    this.backing.set(key, value);
    return true;
  }

  has(key: K): boolean {
    return this.backing.has(key);
  }

  set(key: K, value: V): void {
    this.backing.set(key, value);
  }

  values(): IterableIterator<V> {
    return this.backing.values();
  }
}

class InMemoryAppendOnlyStore<T> implements AppendOnlyStore<T> {
  constructor(private readonly backing: T[]) {}

  get length(): number {
    return this.backing.length;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.backing[Symbol.iterator]();
  }

  clear(): void {
    this.backing.length = 0;
  }

  push(value: T): number {
    return this.backing.push(value);
  }

  some(predicate: (value: T, index: number, array: T[]) => boolean): boolean {
    return this.backing.some(predicate);
  }

  toArray(): T[] {
    return [...this.backing];
  }
}

import { DEFAULT_STREAM_TENANT_ID } from "@/app/lib/stream-view";
import { resolveStreamTenant, visibleTo } from "@/app/lib/stream-visibility";

export { visibleTo, resolveStreamTenant };

function extractParticipants(stream: Stream): string[] {
  const wallets = new Set<string>();
  const sender = stream.senderAddress?.trim();
  const recipient = stream.recipient?.trim();
  if (sender && sender.length > 0) {
    wallets.add(sender);
  }
  if (recipient && recipient.length > 0) {
    wallets.add(recipient);
  }
  return Array.from(wallets);
}

/**
 * Key-value store for `Stream` records that maintains secondary in-memory
 * indexes by tenant (`byTenant`) and by participant wallet (`byParticipant`).
 *
 * All mutations (`set`, `delete`, `clear`) atomically update both indexes,
 * including updates that change `tenantId`/`tenant`, `senderAddress`, or
 * `recipient` on an existing stream ID.
 */
export class IndexedStreamStore implements KeyValueStore<string, Stream> {
  private readonly backing = new Map<string, Stream>();
  private readonly tenantIndex = new Map<string, Set<string>>();
  private readonly participantIndex = new Map<string, Set<string>>();

  constructor(initialEntries?: Iterable<[string, Stream]>) {
    if (initialEntries) {
      for (const [id, stream] of initialEntries) {
        this.set(id, stream);
      }
    }
  }

  get size(): number {
    return this.backing.size;
  }

  /** Read-only view of the tenant -> stream IDs secondary index. */
  get byTenant(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.tenantIndex;
  }

  /** Read-only view of the participant wallet -> stream IDs secondary index. */
  get byParticipant(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.participantIndex;
  }

  clear(): void {
    this.backing.clear();
    this.tenantIndex.clear();
    this.participantIndex.clear();
  }

  delete(id: string): boolean {
    const existing = this.backing.get(id);
    if (!existing) {
      return false;
    }
    this.unindexStream(id, existing);
    return this.backing.delete(id);
  }

  entries(): IterableIterator<[string, Stream]> {
    return this.backing.entries();
  }

  forEach(callbackfn: (value: Stream, key: string) => void): void {
    this.backing.forEach((value, key) => callbackfn(value, key));
  }

  get(id: string): Stream | undefined {
    return this.backing.get(id);
  }

  has(id: string): boolean {
    return this.backing.has(id);
  }

  set(id: string, value: Stream): void {
    const existing = this.backing.get(id);
    if (existing) {
      this.unindexStream(id, existing);
    }
    this.backing.set(id, value);
    this.indexStream(id, value);
  }

  values(): IterableIterator<Stream> {
    return this.backing.values();
  }

  /**
   * Returns all streams belonging to `tenant` in `O(streams in tenant)` time.
   */
  listByTenant(tenant?: string | null): Stream[] {
    const normalizedTenant =
      tenant && tenant.trim().length > 0 ? tenant.trim() : DEFAULT_STREAM_TENANT_ID;
    const ids = this.tenantIndex.get(normalizedTenant);
    if (!ids || ids.size === 0) {
      return [];
    }

    const result: Stream[] = [];
    for (const id of ids) {
      const stream = this.backing.get(id);
      if (stream) {
        result.push(stream);
      }
    }
    return result;
  }

  /**
   * Returns all streams where `walletAddress` is `senderAddress` or `recipient`,
   * optionally restricted to `tenant`.
   */
  listByParticipant(walletAddress: string, tenant?: string | null): Stream[] {
    const normalizedWallet = walletAddress?.trim();
    if (!normalizedWallet) {
      return [];
    }

    const participantIds = this.participantIndex.get(normalizedWallet);
    if (!participantIds || participantIds.size === 0) {
      return [];
    }

    const filterByTenant = tenant !== undefined && tenant !== null;
    const targetTenant = filterByTenant
      ? tenant.trim() || DEFAULT_STREAM_TENANT_ID
      : null;
    const tenantIds = targetTenant ? this.tenantIndex.get(targetTenant) : null;
    if (filterByTenant && (!tenantIds || tenantIds.size === 0)) {
      return [];
    }

    const result: Stream[] = [];
    for (const id of participantIds) {
      if (tenantIds && !tenantIds.has(id)) {
        continue;
      }
      const stream = this.backing.get(id);
      if (stream) {
        result.push(stream);
      }
    }
    return result;
  }

  private indexStream(id: string, stream: Stream): void {
    const tenant = resolveStreamTenant(stream);
    let tenantSet = this.tenantIndex.get(tenant);
    if (!tenantSet) {
      tenantSet = new Set<string>();
      this.tenantIndex.set(tenant, tenantSet);
    }
    tenantSet.add(id);

    for (const wallet of extractParticipants(stream)) {
      let walletSet = this.participantIndex.get(wallet);
      if (!walletSet) {
        walletSet = new Set<string>();
        this.participantIndex.set(wallet, walletSet);
      }
      walletSet.add(id);
    }
  }

  private unindexStream(id: string, stream: Stream): void {
    const tenant = resolveStreamTenant(stream);
    const tenantSet = this.tenantIndex.get(tenant);
    if (tenantSet) {
      tenantSet.delete(id);
      if (tenantSet.size === 0) {
        this.tenantIndex.delete(tenant);
      }
    }

    for (const wallet of extractParticipants(stream)) {
      const walletSet = this.participantIndex.get(wallet);
      if (walletSet) {
        walletSet.delete(id);
        if (walletSet.size === 0) {
          this.participantIndex.delete(wallet);
        }
      }
    }
  }
}

export class InMemoryStreamRepository implements StreamRepository {
  readonly activity = new InMemoryKeyValueStore<string, ActivityEvent>(createActivityMap());
  readonly streams = new IndexedStreamStore(createStreamsMap());
  readonly users = new InMemoryKeyValueStore<string, User>(createUsersMap());
  private readonly locks = new Map<string, Promise<void>>();

  listByTenant(tenant?: string | null): Stream[] {
    return this.streams.listByTenant(tenant);
  }

  listByParticipant(walletAddress: string, tenant?: string | null): Stream[] {
    return this.streams.listByParticipant(walletAddress, tenant);
  }

  reset(): void {
    resetKeyValueStore(this.users, createUsersMap());
    resetKeyValueStore(this.streams, createStreamsMap());
    resetKeyValueStore(this.activity, createActivityMap());
    this.locks.clear();
  }

  async withLock<T>(id: string, callback: () => Promise<T>): Promise<T> {
    const existingLock = this.locks.get(id) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    this.locks.set(id, currentLock);

    try {
      await existingLock;
      return await callback();
    } finally {
      if (this.locks.get(id) === currentLock) {
        this.locks.delete(id);
      }
      releaseCurrent();
    }
  }
}

class InMemoryIdempotencyStore
  extends InMemoryKeyValueStore<string, unknown>
  implements IdempotencyStore
{
  constructor() {
    super(new Map<string, unknown>());
  }

  reset(): void {
    this.clear();
  }
}

class InMemoryExportRepository implements ExportRepository {
  readonly audit = new InMemoryAppendOnlyStore<ExportAuditRecord>([]);
  readonly jobs = new InMemoryKeyValueStore<string, ExportJob>(new Map<string, ExportJob>());
  readonly processing = new InMemoryKeyValueStore<string, Promise<void>>(new Map<string, Promise<void>>());

  reset(): void {
    this.jobs.clear();
    this.audit.clear();
    this.processing.clear();
  }
}

function resetKeyValueStore<K, V>(
  store: KeyValueStore<K, V>,
  nextValues: Map<K, V>,
): void {
  store.clear();
  for (const [key, value] of nextValues.entries()) {
    store.set(key, value);
  }
}

export function createInMemoryPersistenceStore(seedTimeline?: boolean): PersistenceStore {
  const timeline = createActivityTimelineStore();
  const store: PersistenceStore = {
    kind: "memory",
    activityTimeline: timeline,
    streamHistory: createStreamHistoryStore(),
    streamRepository: new InMemoryStreamRepository(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    exportRepository: new InMemoryExportRepository(),
  };

  if (seedTimeline !== false) {
    const activity = store.streamRepository.activity;
    const entries: import("@/app/lib/repositories/activity-timeline").ActivityTimelineEntry[] = [];
    activity.forEach((event) => {
      entries.push(activityEventToTimelineEntry(event, event.timestamp));
    });
    timeline.backfill(entries);
  }

  return store;
}
