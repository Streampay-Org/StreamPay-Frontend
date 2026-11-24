import {
  InMemoryPushSubscriptionStore,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  type PushSubscriptionData,
} from "./push-store";

function subscription(endpoint: string): PushSubscriptionData {
  return { endpoint, keys: { p256dh: "public", auth: "secret" } };
}

describe("InMemoryPushSubscriptionStore", () => {
  it("is idempotent for duplicate endpoints and replaces subscription keys", () => {
    const store = new InMemoryPushSubscriptionStore();
    const first = subscription("https://push.example/1");

    expect(store.add("wallet-a", first, MAX_PUSH_SUBSCRIPTIONS_PER_USER)).toBe("created");
    expect(
      store.add("wallet-a", { ...first, keys: { p256dh: "updated", auth: "updated" } }, 1),
    ).toBe("updated");
    expect(store.listForUser("wallet-a")).toEqual([
      { ...first, keys: { p256dh: "updated", auth: "updated" }, userId: "wallet-a" },
    ]);
  });

  it("enforces the per-user subscription limit and scopes removals to the owner", () => {
    const store = new InMemoryPushSubscriptionStore();
    store.add("wallet-a", subscription("https://push.example/1"), 1);

    expect(store.add("wallet-a", subscription("https://push.example/2"), 1)).toBe("limit");
    expect(store.remove("wallet-b", "https://push.example/1")).toBe(false);
    expect(store.remove("wallet-a", "https://push.example/1")).toBe(true);
    expect(store.listForUser("wallet-a")).toEqual([]);
  });

  it("does not allow another user to claim an existing endpoint", () => {
    const store = new InMemoryPushSubscriptionStore();
    const existing = subscription("https://push.example/1");
    store.add("wallet-a", existing, 10);

    expect(store.add("wallet-b", existing, 10)).toBe("conflict");
    expect(store.listForUser("wallet-a")).toHaveLength(1);
    expect(store.listForUser("wallet-b")).toEqual([]);
  });
});
