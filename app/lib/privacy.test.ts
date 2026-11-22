import { redact, processDeletionRequest } from "./privacy";
import { getStore } from "./db";
import { Stream } from "@/app/types/openapi";

const UUID_REQUEST_ID_RE =
  /^dsr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeStream(overrides: Partial<Stream> & Record<string, unknown> = {}): Stream {
  return {
    id: "stream-default",
    recipient: "GDECOY000000000000000000000000000000000000000000000000000",
    rate: "10 XLM/day",
    schedule: "daily",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    token: "XLM",
    ...overrides,
  } as Stream;
}

describe("privacy", () => {
  it("redacts sensitive keys", () => {
    const data = {
      publicKey: "G123456789",
      signature: "some-sig",
      email: "test@example.org",
      amount: "100",
      nested: {
        secret: "top-secret",
      },
    };
    const redacted = redact(data);
    expect(redacted.publicKey).toBe("[REDACTED]");
    expect(redacted.signature).toBe("[REDACTED]");
    expect(redacted.email).toBe("[REDACTED]");
    expect(redacted.amount).toBe("100");
    expect(redacted.nested.secret).toBe("[REDACTED]");
  });

  describe("processDeletionRequest", () => {
    const createdStreamIds: string[] = [];
    const createdUserWallets: string[] = [];

    function seedStream(stream: Stream) {
      const { streamRepository } = getStore();
      streamRepository.streams.set(stream.id, stream);
      createdStreamIds.push(stream.id);
    }

    function seedUser(wallet: string, email: string | null, displayName: string) {
      const { streamRepository } = getStore();
      streamRepository.users.set(wallet, {
        wallet_address: wallet,
        email,
        display_name: displayName,
        avatar_url: null,
        created_at: "2026-01-01T00:00:00.000Z",
        last_seen: null,
      });
      createdUserWallets.push(wallet);
    }

    afterEach(() => {
      const { streamRepository } = getStore();
      for (const id of createdStreamIds.splice(0)) {
        streamRepository.streams.delete(id);
      }
      for (const wallet of createdUserWallets.splice(0)) {
        streamRepository.users.delete(wallet);
      }
    });

    it("scrubs only exact wallet/email matches and leaves decoy streams untouched byte for byte", async () => {
      const wallet = "GALEX0000000000000000000000000000000000000000000000000001";
      seedUser(wallet, "Al@Example.COM", "Al");

      // Owned streams (should be scrubbed)
      seedStream(
        makeStream({
          id: "owned-by-recipient",
          recipient: wallet,
          email: "other@example.com",
          label: "My Salary",
          memo: "Private",
          partnerId: "P-1",
        })
      );
      seedStream(
        makeStream({
          id: "owned-by-sender-address",
          recipient: "GOTHER000000000000000000000000000000000000000000000000001",
          senderAddress: wallet,
          email: "payee@example.com",
          label: "Outbound",
          memo: "Contractor",
          partnerId: "P-2",
        })
      );
      seedStream(
        makeStream({
          id: "owned-by-sender-alias",
          recipient: "GOTHER000000000000000000000000000000000000000000000000002",
          sender: wallet,
          label: "Legacy Sender",
        })
      );
      seedStream(
        makeStream({
          id: "owned-by-recipient-address-alias",
          recipient: "Alice Label",
          recipientAddress: wallet,
          label: "Legacy RecipientAddress",
        })
      );
      seedStream(
        makeStream({
          id: "owned-by-case-insensitive-email",
          recipient: "GOTHER000000000000000000000000000000000000000000000000003",
          email: "al@example.com",
          label: "Email Match",
          memo: "Matched case-insensitively",
        })
      );

      // Decoy streams (must be completely untouched)
      const decoyNameInRecipient = makeStream({
        id: "decoy-display-name-in-recipient",
        recipient: "Alice Johnson",
        email: "alice@example.com",
        label: "Alice Payroll",
        memo: "Do not scrub",
        partnerId: "P-DECOY-1",
      });
      const decoyNameInLabel = makeStream({
        id: "decoy-display-name-in-label",
        recipient: "GOTHER000000000000000000000000000000000000000000000000004",
        email: "albert@example.com",
        label: "Al's Bakery",
        memo: "Keep intact",
        partnerId: "P-DECOY-2",
      });
      const decoyWalletSubstring = makeStream({
        id: "decoy-wallet-substring",
        recipient: `prefix-${wallet}-suffix`,
        email: "substring@example.com",
        label: "Substring Decoy",
        memo: "Should stay",
        partnerId: "P-DECOY-3",
      });
      const decoyNoEmail = makeStream({
        id: "decoy-no-email",
        recipient: "GOTHER000000000000000000000000000000000000000000000000005",
        email: undefined,
        label: "No Email Stream",
        memo: "Untouched",
        partnerId: "P-DECOY-4",
      });

      const decoySnapshots = [
        decoyNameInRecipient,
        decoyNameInLabel,
        decoyWalletSubstring,
        decoyNoEmail,
      ].map((s) => ({ id: s.id, snapshot: structuredClone(s) }));

      for (const decoy of [
        decoyNameInRecipient,
        decoyNameInLabel,
        decoyWalletSubstring,
        decoyNoEmail,
      ]) {
        seedStream(decoy);
      }

      const result = await processDeletionRequest(wallet);

      expect(result.status).toBe("processing");
      expect(result.requestId).toMatch(UUID_REQUEST_ID_RE);
      expect(result.scrubbedCount).toBe(5);

      const { streamRepository } = getStore();
      expect(streamRepository.users.has(wallet)).toBe(false);

      for (const ownedId of [
        "owned-by-recipient",
        "owned-by-sender-address",
        "owned-by-sender-alias",
        "owned-by-recipient-address-alias",
        "owned-by-case-insensitive-email",
      ]) {
        const scrubbed = streamRepository.streams.get(ownedId);
        expect(scrubbed).toBeDefined();
        expect(scrubbed?.email).toBeUndefined();
        expect(scrubbed?.label).toBeUndefined();
        expect(scrubbed?.memo).toBeUndefined();
        expect(scrubbed?.partnerId).toBeUndefined();
      }

      for (const { id, snapshot } of decoySnapshots) {
        expect(streamRepository.streams.get(id)).toEqual(snapshot);
      }
    });

    it("does not match streams without email when user has no stored email or empty display name", async () => {
      const wallet = "GNOEMAIL0000000000000000000000000000000000000000000000001";
      seedUser(wallet, null, "");

      const noEmailDecoy = makeStream({
        id: "decoy-undefined-email",
        recipient: "GOTHER000000000000000000000000000000000000000000000000009",
        email: undefined,
        label: "Must Remain",
        memo: "Must Remain Memo",
        partnerId: "P-KEEP",
      });
      const snapshot = structuredClone(noEmailDecoy);
      seedStream(noEmailDecoy);

      const result = await processDeletionRequest(wallet);

      expect(result.scrubbedCount).toBe(0);
      expect(result.requestId).toMatch(UUID_REQUEST_ID_RE);
      expect(getStore().streamRepository.streams.get(noEmailDecoy.id)).toEqual(snapshot);
    });

    it("does not scrub decoys when display name equals a wallet substring or user is not found", async () => {
      const wallet = "GSUBSTR00000000000000000000000000000000000000000000000001";
      const decoy = makeStream({
        id: "decoy-wallet-substr-display-name",
        recipient: "GOTHER000000000000000000000000000000000000000000000000010",
        email: undefined,
        label: "Wallet Substring Decoy",
      });
      const snapshot = structuredClone(decoy);
      seedStream(decoy);

      // User with display name equal to a substring of decoy.recipient
      seedUser(wallet, "", "GOTHER");
      const res1 = await processDeletionRequest(wallet);
      expect(res1.scrubbedCount).toBe(0);
      expect(getStore().streamRepository.streams.get(decoy.id)).toEqual(snapshot);

      // User not found at all
      const res2 = await processDeletionRequest(
        "GUNKNOWN0000000000000000000000000000000000000000000000001"
      );
      expect(res2.scrubbedCount).toBe(0);
      expect(getStore().streamRepository.streams.get(decoy.id)).toEqual(snapshot);
    });

    it("generates unique UUID-based request IDs", async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const res = await processDeletionRequest(
          `GUNIQUE000000000000000000000000000000000000000000000000${i}`
        );
        expect(res.requestId).toMatch(UUID_REQUEST_ID_RE);
        ids.add(res.requestId);
      }
      expect(ids.size).toBe(10);
    });
  });
});
