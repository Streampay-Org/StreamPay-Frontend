
/**
 * @jest-environment jsdom
 */

import fs from "node:fs";
import path from "node:path";

describe("StreamPay embed loader", () => {
  let scriptContent: string;

  beforeAll(() => {
    scriptContent = fs.readFileSync(
      path.join(process.cwd(), "public/embed.js"),
      "utf8",
    );
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <script src="https://streampay.example/embed.js"></script>
      <div data-streampay-stream="stream-123" data-token="test-token"></div>
    `;
  });

  it("creates a sandboxed iframe for the stream", () => {
    window.eval(scriptContent);

    const iframe = document.querySelector<HTMLIFrameElement>("iframe");

    expect(iframe).not.toBeNull();
    expect(iframe?.src).toContain("/embed/stream/stream-123");
    expect(iframe?.src).toContain("t=test-token");
    expect(iframe?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin",
    );
    expect(iframe?.loading).toBe("lazy");
    expect(iframe?.referrerPolicy).toBe("no-referrer");
  });

  it("resizes the iframe only for valid widget messages", () => {
    window.eval(scriptContent);

    const iframe = document.querySelector<HTMLIFrameElement>("iframe");

    expect(iframe).not.toBeNull();
    if (!iframe) return;

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://malicious.example",
        source: iframe.contentWindow,
        data: { type: "streampay:resize", height: 500 },
      }),
    );

    expect(iframe.style.height).toBe("360px");

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://streampay.example",
        source: iframe.contentWindow,
        data: { type: "streampay:resize", height: 500 },
      }),
    );

    expect(iframe.style.height).toBe("500px");
  });

  it("caps excessive iframe heights", () => {
    window.eval(scriptContent);

    const iframe = document.querySelector<HTMLIFrameElement>("iframe");

    expect(iframe).not.toBeNull();
    if (!iframe) return;

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://streampay.example",
        source: iframe.contentWindow,
        data: { type: "streampay:resize", height: 5000 },
      }),
    );

    expect(iframe.style.height).toBe("1200px");
  });
});
