import { isValidStellarPublicKey } from "../lib/stellar-address";

export interface FederationRecord {
  stellar_address: string;
  account_id: string;
  memo_type?: "text" | "id" | "hash";
  memo?: string;
}

export type FederationErrorCode =
  | "INVALID_FORMAT"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "SERVER_ERROR"
  | "INVALID_RESPONSE";

export class FederationError extends Error {
  constructor(
    message: string,
    public readonly code: FederationErrorCode,
  ) {
    super(message);
    this.name = "FederationError";
  }
}

// user*domain.com — one asterisk, non-empty parts on both sides, domain has a dot
const FEDERATION_ADDRESS_RE = /^[^*\s]+\*[^*\s]+\.[^*\s]+$/;

const cache = new Map<string, FederationRecord>();
const cacheTimestamps = new Map<string, number>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function isFederationAddress(value: string): boolean {
  return FEDERATION_ADDRESS_RE.test(value);
}

export function parseFederationAddress(address: string): {
  username: string;
  domain: string;
} {
  if (!isFederationAddress(address)) {
    throw new FederationError(
      `Invalid Stellar federation address: "${address}"`,
      "INVALID_FORMAT",
    );
  }
  const idx = address.indexOf("*");
  return { username: address.slice(0, idx), domain: address.slice(idx + 1) };
}

async function fetchFederationServerUrl(domain: string): Promise<string> {
  const tomlUrl = `https://${domain}/.well-known/stellar.toml`;
  let response: Response;
  try {
    response = await fetch(tomlUrl, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new FederationError(
      `Could not reach ${domain} to fetch stellar.toml`,
      "NETWORK_ERROR",
    );
  }

  if (!response.ok) {
    throw new FederationError(
      `stellar.toml not found for domain "${domain}"`,
      "NOT_FOUND",
    );
  }

  const text = await response.text();
  const match = text.match(/FEDERATION_SERVER\s*=\s*"?([^"\n]+)"?/);
  if (!match) {
    throw new FederationError(
      `No FEDERATION_SERVER entry in ${domain}'s stellar.toml`,
      "NOT_FOUND",
    );
  }

  return match[1].trim();
}

export function validateFederationResponse(
  raw: unknown,
  query: string,
): FederationRecord {
  if (!raw || typeof raw !== "object") {
    throw new FederationError(
      "Federation response must be a valid JSON object",
      "INVALID_RESPONSE",
    );
  }

  const record = raw as Record<string, unknown>;

  // account_id must pass isValidStellarPublicKey
  if (
    typeof record.account_id !== "string" ||
    !isValidStellarPublicKey(record.account_id)
  ) {
    throw new FederationError(
      "Federation response contains invalid or checksum-failing account_id",
      "INVALID_RESPONSE",
    );
  }

  // stellar_address must equal the query, ignoring case
  if (
    typeof record.stellar_address !== "string" ||
    record.stellar_address.trim().toLowerCase() !== query.trim().toLowerCase()
  ) {
    throw new FederationError(
      `stellar_address in federation response "${record.stellar_address}" does not match query "${query}"`,
      "INVALID_RESPONSE",
    );
  }

  const memoType = record.memo_type;
  const memo = record.memo;

  if (memoType !== undefined || memo !== undefined) {
    if (memoType === undefined || memo === undefined) {
      throw new FederationError(
        "Both memo_type and memo must be provided if either is present",
        "INVALID_RESPONSE",
      );
    }

    if (
      typeof memoType !== "string" ||
      (memoType !== "text" && memoType !== "id" && memoType !== "hash")
    ) {
      throw new FederationError(
        `Invalid memo_type "${String(memoType)}": must be 'text', 'id', or 'hash'`,
        "INVALID_RESPONSE",
      );
    }

    if (typeof memo !== "string") {
      throw new FederationError(
        "memo must be a string",
        "INVALID_RESPONSE",
      );
    }

    if (memoType === "text") {
      const bytes = new TextEncoder().encode(memo);
      if (bytes.length > 28) {
        throw new FederationError(
          `memo of type 'text' exceeds 28 bytes (${bytes.length} bytes)`,
          "INVALID_RESPONSE",
        );
      }
    } else if (memoType === "id") {
      if (!/^\d+$/.test(memo)) {
        throw new FederationError(
          `memo of type 'id' must be an unsigned 64-bit integer string: "${memo}"`,
          "INVALID_RESPONSE",
        );
      }
      try {
        const val = BigInt(memo);
        if (val < 0n || val > 18446744073709551615n) {
          throw new FederationError(
            `memo of type 'id' is out of range for uint64: "${memo}"`,
            "INVALID_RESPONSE",
          );
        }
      } catch {
        throw new FederationError(
          `memo of type 'id' cannot be parsed: "${memo}"`,
          "INVALID_RESPONSE",
        );
      }
    } else if (memoType === "hash") {
      let valid = false;
      if (/^[0-9a-fA-F]{64}$/.test(memo)) {
        valid = true;
      } else if (
        /^[A-Za-z0-9+/]{43}=$/.test(memo) ||
        /^[A-Za-z0-9-_]{43}=$/.test(memo)
      ) {
        try {
          if (typeof atob === "function") {
            const decoded = atob(memo.replace(/-/g, "+").replace(/_/g, "/"));
            if (decoded.length === 32) {
              valid = true;
            }
          }
        } catch {
          valid = false;
        }
      }

      if (!valid) {
        throw new FederationError(
          `memo of type 'hash' must be 32 bytes in hex or base64: "${memo}"`,
          "INVALID_RESPONSE",
        );
      }
    }

    return {
      stellar_address: record.stellar_address,
      account_id: record.account_id,
      memo_type: memoType as "text" | "id" | "hash",
      memo,
    };
  }

  return {
    stellar_address: record.stellar_address,
    account_id: record.account_id,
  };
}

export async function resolveFederationAddress(
  address: string,
  options: { bypassCache?: boolean } = {},
): Promise<FederationRecord> {
  if (!isFederationAddress(address)) {
    throw new FederationError(
      `"${address}" is not a valid Stellar federation address`,
      "INVALID_FORMAT",
    );
  }

  const key = address.toLowerCase();

  if (!options.bypassCache) {
    const hit = cache.get(key);
    const ts = cacheTimestamps.get(key) ?? 0;
    if (hit && Date.now() - ts < CACHE_TTL_MS) {
      return hit;
    }
  }

  const { domain } = parseFederationAddress(key);
  const federationUrl = await fetchFederationServerUrl(domain);

  const queryUrl = new URL(federationUrl);
  queryUrl.searchParams.set("q", key);
  queryUrl.searchParams.set("type", "name");

  let response: Response;
  try {
    response = await fetch(queryUrl.toString(), {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new FederationError(
      `Could not reach federation server for "${domain}"`,
      "NETWORK_ERROR",
    );
  }

  if (response.status === 404) {
    throw new FederationError(
      `Federation address "${address}" was not found`,
      "NOT_FOUND",
    );
  }

  if (!response.ok) {
    throw new FederationError(
      `Federation server returned HTTP ${response.status} for "${address}"`,
      "SERVER_ERROR",
    );
  }

  let rawData: unknown;
  try {
    rawData = await response.json();
  } catch {
    throw new FederationError(
      `Federation server returned invalid JSON for "${address}"`,
      "INVALID_RESPONSE",
    );
  }

  const record = validateFederationResponse(rawData, key);

  cache.set(key, record);
  cacheTimestamps.set(key, Date.now());

  return record;
}

export function clearFederationCache(): void {
  cache.clear();
  cacheTimestamps.clear();
}
