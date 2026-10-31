/** @jest-environment node */
import { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } from "./route";
jest.mock("@/app/lib/logger", () => ({ getCorrelationContext: () => undefined }));
describe("unknown API paths", () => {
  test.each([GET, POST, PUT, PATCH, DELETE, OPTIONS])("returns the canonical JSON 404 envelope", async (method) => {
    const response = method(new Request("https://example.test/api/unknown?secret=hidden"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const { error } = await response.json();
    expect(error.code).toBe("NOT_FOUND");
    expect(error.request_id).toEqual(expect.any(String));
    expect(error.message).not.toContain("secret");
  });
  it("returns no response body for HEAD", async () => {
    const response = HEAD(new Request("https://example.test/api/unknown"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});
