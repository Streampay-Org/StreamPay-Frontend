export interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface StoredPushSubscription extends PushSubscriptionData {
  userId: string;
}

export type AddPushSubscriptionResult = "created" | "updated" | "limit" | "conflict";

export interface PushSubscriptionStore {
  add(
    userId: string,
    subscription: PushSubscriptionData,
    maxSubscriptions: number,
  ): AddPushSubscriptionResult;
  listForUser(userId: string): StoredPushSubscription[];
  remove(userId: string, endpoint: string): boolean;
}

export class InMemoryPushSubscriptionStore implements PushSubscriptionStore {
  private readonly subscriptions = new Map<string, StoredPushSubscription>();

  add(
    userId: string,
    subscription: PushSubscriptionData,
    maxSubscriptions: number,
  ): AddPushSubscriptionResult {
    const existing = this.subscriptions.get(subscription.endpoint);
    if (existing?.userId === userId) {
      this.subscriptions.set(subscription.endpoint, { ...subscription, userId });
      return "updated";
    }
    if (existing) return "conflict";

    if (this.listForUser(userId).length >= maxSubscriptions) {
      return "limit";
    }

    this.subscriptions.set(subscription.endpoint, { ...subscription, userId });
    return "created";
  }

  listForUser(userId: string): StoredPushSubscription[] {
    return Array.from(this.subscriptions.values()).filter(
      (subscription) => subscription.userId === userId,
    );
  }

  remove(userId: string, endpoint: string): boolean {
    if (this.subscriptions.get(endpoint)?.userId !== userId) return false;
    return this.subscriptions.delete(endpoint);
  }
}

let activeStore: PushSubscriptionStore = new InMemoryPushSubscriptionStore();

export function getPushSubscriptionStore(): PushSubscriptionStore {
  return activeStore;
}

export function setPushSubscriptionStoreForTesting(
  store: PushSubscriptionStore | null,
): void {
  activeStore = store ?? new InMemoryPushSubscriptionStore();
}

export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;
