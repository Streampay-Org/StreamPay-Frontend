import { updateLastSeen } from "./lastSeen";
import { setStore, resetDb, getStore } from "./db";
import { createInMemoryPersistenceStore } from "./repositories/in-memory";

describe("lastSeen", () => {
  beforeEach(() => {
    // Use a fresh in-memory store for each test
    setStore(createInMemoryPersistenceStore(false));
  });

  afterEach(() => {
    resetDb();
  });

  test("updates last_seen for existing user", () => {
    const walletAddress = "GD7H...3J4K";
    setStore(createInMemoryPersistenceStore());
    const users = getStore().streamRepository.users;
    const initialUser = users.get(walletAddress);
    expect(initialUser?.last_seen).toBeNull();

    const beforeTime = new Date().toISOString();
    updateLastSeen(walletAddress);
    const afterTime = new Date().toISOString();

    const updatedUser = users.get(walletAddress);
    expect(updatedUser?.last_seen).not.toBeNull();
    expect(updatedUser!.last_seen! >= beforeTime).toBe(true);
    expect(updatedUser!.last_seen! <= afterTime).toBe(true);
  });

  test("creates minimal user and sets last_seen if user doesn't exist", () => {
    const walletAddress = "GTEST...1234";
    const users = getStore().streamRepository.users;
    expect(users.get(walletAddress)).toBeUndefined();

    const beforeTime = new Date().toISOString();
    updateLastSeen(walletAddress);
    const afterTime = new Date().toISOString();

    const newUser = users.get(walletAddress);
    expect(newUser).not.toBeUndefined();
    expect(newUser?.wallet_address).toBe(walletAddress);
    expect(newUser?.email).toBeNull();
    expect(newUser?.display_name).toBe("");
    expect(newUser?.avatar_url).toBeNull();
    expect(newUser!.created_at! >= beforeTime).toBe(true);
    expect(newUser!.created_at! <= afterTime).toBe(true);
    expect(newUser?.last_seen).toBe(newUser?.created_at);
  });
});
