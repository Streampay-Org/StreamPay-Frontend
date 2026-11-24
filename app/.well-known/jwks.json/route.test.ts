import { GET } from "./route";

describe("GET /\.well-known/jwks.json", () => {
  it("returns a JWKS payload with no-store caching", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toHaveProperty("keys");
    expect(Array.isArray(body.keys)).toBe(true);
  });
});
