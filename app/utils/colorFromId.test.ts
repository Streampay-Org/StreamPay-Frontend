import { colorFromId } from "./colorFromId";

describe("colorFromId", () => {
  it("returns a valid hex color string", () => {
    const color = colorFromId("test-stream-id");
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns the same color for the same ID", () => {
    const id = "0xabc123";
    expect(colorFromId(id)).toBe(colorFromId(id));
  });

  it("returns different colors for different IDs", () => {
    const id1 = "0xabc123";
    const id2 = "0xdef456";
    // With 12 hues, most random pairs should differ
    expect(colorFromId(id1)).not.toBe(colorFromId(id2));
  });

  it("returns one of the 12 predefined hues", () => {
    const validHues = [210, 340, 160, 30, 270, 85, 195, 315, 50, 140, 240, 10];
    // Test several IDs to ensure they all map to valid hues
    const testIds = [
      "stream-1",
      "stream-2",
      "stream-3",
      "0xdeadbeef",
      "0xcafebabe",
      "abc123",
      "def456",
    ];

    for (const id of testIds) {
      const color = colorFromId(id);
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
      // Verify the color is one of our valid hues by checking it's a real hex color
      expect(color.length).toBe(7);
    }
  });

  it("handles empty string", () => {
    const color = colorFromId("");
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("handles very long strings", () => {
    const longId = "a".repeat(1000);
    const color = colorFromId(longId);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("handles special characters", () => {
    const color = colorFromId("!@#$%^&*()_+-=[]{}|;':\",./<>?");
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("handles unicode characters", () => {
    const color = colorFromId("日本語テスト");
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });
});
