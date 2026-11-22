import {
  InMemoryTokenDenylist,
  getTokenDenylist,
  resetTokenDenylist,
  setTokenDenylist,
} from "./token-denylist";

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;

describe("InMemoryTokenDenylist", () => {
  it("reports a revoked token id", () => {
    const denylist = new InMemoryTokenDenylist({ nowFn: () => NOW_MS });

    denylist.revoke("jti-1", NOW_SECONDS + 60);

    expect(denylist.isRevoked("jti-1")).toBe(true);
    expect(denylist.isRevoked("jti-2")).toBe(false);
  });

  it("prunes entries once the token expiry passes", () => {
    let now = NOW_MS;
    const denylist = new InMemoryTokenDenylist({ nowFn: () => now });

    denylist.revoke("jti-1", NOW_SECONDS + 60);
    expect(denylist.size()).toBe(1);

    now += 60_001;

    expect(denylist.isRevoked("jti-1")).toBe(false);
    expect(denylist.size()).toBe(0);
  });

  it("does not store a token that is already expired", () => {
    const denylist = new InMemoryTokenDenylist({ nowFn: () => NOW_MS });

    denylist.revoke("jti-1", NOW_SECONDS - 1);

    expect(denylist.size()).toBe(0);
    expect(denylist.isRevoked("jti-1")).toBe(false);
  });

  it("ignores non-finite expiries and empty ids", () => {
    const denylist = new InMemoryTokenDenylist({ nowFn: () => NOW_MS });

    denylist.revoke("jti-1", Number.NaN);
    denylist.revoke("jti-2", Number.POSITIVE_INFINITY);
    denylist.revoke("", NOW_SECONDS + 60);

    expect(denylist.size()).toBe(0);
    expect(denylist.isRevoked("")).toBe(false);
  });

  it("refreshes the expiry when a token is revoked again", () => {
    let now = NOW_MS;
    const denylist = new InMemoryTokenDenylist({ nowFn: () => now });

    denylist.revoke("jti-1", NOW_SECONDS + 30);
    denylist.revoke("jti-1", NOW_SECONDS + 120);

    now += 60_000;

    expect(denylist.isRevoked("jti-1")).toBe(true);
  });

  it("evicts the oldest entry once the size bound is reached", () => {
    const denylist = new InMemoryTokenDenylist({
      nowFn: () => NOW_MS,
      maxEntries: 2,
    });

    denylist.revoke("jti-1", NOW_SECONDS + 60);
    denylist.revoke("jti-2", NOW_SECONDS + 60);
    denylist.revoke("jti-3", NOW_SECONDS + 60);

    expect(denylist.size()).toBe(2);
    expect(denylist.isRevoked("jti-1")).toBe(false);
    expect(denylist.isRevoked("jti-2")).toBe(true);
    expect(denylist.isRevoked("jti-3")).toBe(true);
  });

  it("clears every entry", () => {
    const denylist = new InMemoryTokenDenylist({ nowFn: () => NOW_MS });
    denylist.revoke("jti-1", NOW_SECONDS + 60);

    denylist.clear();

    expect(denylist.isRevoked("jti-1")).toBe(false);
  });
});

describe("token denylist singleton", () => {
  afterEach(() => {
    resetTokenDenylist();
  });

  it("returns an in-memory denylist by default", () => {
    expect(getTokenDenylist()).toBeInstanceOf(InMemoryTokenDenylist);
  });

  it("allows swapping the implementation", () => {
    const custom = {
      revoke: jest.fn(),
      isRevoked: jest.fn(() => true),
    };

    setTokenDenylist(custom);

    expect(getTokenDenylist()).toBe(custom);
    expect(getTokenDenylist().isRevoked("anything")).toBe(true);
  });

  it("reset installs a fresh empty denylist", () => {
    getTokenDenylist().revoke("jti-1", Math.floor(Date.now() / 1000) + 60);
    expect(getTokenDenylist().isRevoked("jti-1")).toBe(true);

    resetTokenDenylist();

    expect(getTokenDenylist().isRevoked("jti-1")).toBe(false);
  });
});
