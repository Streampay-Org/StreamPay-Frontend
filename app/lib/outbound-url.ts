import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";

export class UnsafeOutboundUrlError extends Error {
  constructor() { super("Endpoint must resolve exclusively to public addresses."); this.name = "UnsafeOutboundUrlError"; }
}
type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
export interface SafeOutboundTarget { url: URL; address: string; family: 4 | 6 }

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
      a === 203 && b === 0 && c === 113);
  }
  if (family !== 6) return false;
  const value = address.toLowerCase();
  if (value.startsWith("::ffff:")) {
    const tail = value.slice(7);
    if (tail.includes(".")) return publicAddress(tail);
    const parts = tail.split(":");
    if (parts.length !== 2) return false;
    const high = Number.parseInt(parts[0], 16), low = Number.parseInt(parts[1], 16);
    return publicAddress([high >> 8, high & 255, low >> 8, low & 255].join("."));
  }
  // Accept global unicast only; reject documentation and transition ranges.
  const first = Number.parseInt(value.split(":")[0], 16);
  const second = Number.parseInt(value.split(":")[1] || "0", 16);
  if (first === 0x2001 && second < 0x200) return false;
  return first >= 0x2000 && first <= 0x3fff &&
    !value.startsWith("2001:db8:") && !value.startsWith("2001:0:") &&
    !value.startsWith("2002:");
}

export async function assertSafeOutboundUrl(
  raw: string,
  { allowHttp = false, resolve = async (host: string) => lookup(host, { all: true, verbatim: true }) }:
    { allowHttp?: boolean; resolve?: Resolver } = {},
): Promise<SafeOutboundTarget> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeOutboundUrlError(); }
  const httpAllowed = allowHttp && process.env.NODE_ENV !== "production";
  if (url.protocol !== "https:" && !(httpAllowed && url.protocol === "http:")) throw new UnsafeOutboundUrlError();
  if (url.username || url.password || url.port && !["443", "8443"].includes(url.port)) throw new UnsafeOutboundUrlError();
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname === "metadata" ||
    [".localhost", ".local", ".internal", ".home.arpa", ".lan"].some(suffix => hostname.endsWith(suffix))) {
    throw new UnsafeOutboundUrlError();
  }
  let addresses: Address[];
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname); }
  catch { throw new UnsafeOutboundUrlError(); }
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new UnsafeOutboundUrlError();
  const address = addresses[0].address;
  return { url, address, family: isIP(address) as 4 | 6 };
}

/** Native HTTP connects to the pinned address while retaining the original Host/SNI.
 * It never follows redirects and never buffers the destination's response body.
 */
export function pinnedWebhookFetch(target: SafeOutboundTarget, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (init.body != null && typeof init.body !== "string") {
      reject(new Error("Webhook payload must be a JSON string.")); return;
    }
    const options: RequestOptions = {
      method: init.method ?? "POST",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      signal: init.signal ?? undefined,
      family: target.family,
      lookup: (_hostname, settings, callback) => {
        if (typeof settings === "object" && settings.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      },
    };
    const send = target.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(target.url, options, response => {
      const status = response.statusCode ?? 502;
      const statusText = response.statusMessage ?? "";
      response.destroy();
      resolve(new Response(null, { status, statusText }));
    });
    request.setTimeout(10_000, () => request.destroy(new Error("Outbound request timeout")));
    request.once("error", reject);
    request.end(init.body ?? undefined);
  });
}
