/** @jest-environment node */

import { newStreamId } from "./stream-id";

describe("newStreamId", () => {
  it("matches ^stream-[a-z0-9]{20,}$ format", () => {
    const id = newStreamId();
    expect(id).toMatch(/^stream-[a-z0-9]{20,}$/);
  });

  it("conforms to composite cursor [\\w-]{1,128} rule", () => {
    const id = newStreamId();
    expect(id).toMatch(/^[\w-]{1,128}$/);
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it("generates distinct identifiers with high entropy", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(newStreamId());
    }
    expect(ids.size).toBe(1000);
  });
});
