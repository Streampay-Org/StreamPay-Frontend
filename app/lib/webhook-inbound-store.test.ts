import {
  InMemoryWebhookInboundStore,
  getWebhookInboundStore,
  resetWebhookInboundStore,
  setWebhookInboundStore,
  type WebhookInboundStore,
} from "./webhook-inbound-store";

describe("InMemoryWebhookInboundStore", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-26T12:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
    resetWebhookInboundStore();
  });

  it("tracks seen and unseen event IDs", () => {
    const store = new InMemoryWebhookInboundStore(60_000);
    expect(store.seen("evt_1")).toBe(false);

    store.markSeen("evt_1");
    expect(store.seen("evt_1")).toBe(true);
    expect(store.seen("evt_2")).toBe(false);
  });

  it("evicts entries after TTL expiry", () => {
    const store = new InMemoryWebhookInboundStore(10_000);
    store.markSeen("evt_ttl", 5_000);

    expect(store.seen("evt_ttl")).toBe(true);

    jest.advanceTimersByTime(4_999);
    expect(store.seen("evt_ttl")).toBe(true);

    jest.advanceTimersByTime(1);
    expect(store.seen("evt_ttl")).toBe(false);
    expect(store.size()).toBe(0);
  });

  it("supports atomic tryMarkSeen for duplicate detection", () => {
    const store = new InMemoryWebhookInboundStore(60_000);

    expect(store.tryMarkSeen("evt_dup")).toBe(true);
    expect(store.tryMarkSeen("evt_dup")).toBe(false);

    jest.advanceTimersByTime(60_000);
    expect(store.tryMarkSeen("evt_dup")).toBe(true);
  });

  it("unmarks an event so it can be retried", () => {
    const store = new InMemoryWebhookInboundStore(60_000);
    store.markSeen("evt_retry");
    expect(store.seen("evt_retry")).toBe(true);

    store.unmark("evt_retry");
    expect(store.seen("evt_retry")).toBe(false);
    expect(store.tryMarkSeen("evt_retry")).toBe(true);
  });

  it("evicts expired entries on markSeen and evictExpired", () => {
    const store = new InMemoryWebhookInboundStore(60_000);
    store.markSeen("evt_a", 1_000);
    store.markSeen("evt_b", 5_000);

    jest.advanceTimersByTime(2_000);
    expect(store.evictExpired()).toBe(1);
    expect(store.seen("evt_a")).toBe(false);
    expect(store.seen("evt_b")).toBe(true);
  });

  it("allows plugging in a custom WebhookInboundStore implementation", () => {
    const custom: WebhookInboundStore = {
      seen: jest.fn(() => false),
      markSeen: jest.fn(),
      unmark: jest.fn(),
      tryMarkSeen: jest.fn(() => true),
      clear: jest.fn(),
    };

    setWebhookInboundStore(custom);
    expect(getWebhookInboundStore()).toBe(custom);

    resetWebhookInboundStore();
    expect(getWebhookInboundStore()).not.toBe(custom);
  });
});
