/** @jest-environment node */
jest.mock("node:https", () => ({ request: jest.fn() }));
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ClientRequest } from "node:http";
import { pinnedWebhookFetch } from "./outbound-url";
it("pins lookup to the validated address, preserves the TLS hostname and does not follow redirects", async () => {
  const response = { statusCode: 302, statusMessage: "Found", destroy: jest.fn() };
  const request = { setTimeout: jest.fn(), once: jest.fn(), end: jest.fn() };
  jest.mocked(httpsRequest).mockImplementation((_url, _options, callback) => {
    callback!(response as unknown as IncomingMessage);
    return request as unknown as ClientRequest;
  });
  const target = { url: new URL("https://hooks.example.com/webhook"), address: "93.184.216.34", family: 4 as const };
  const result = await pinnedWebhookFetch(target, { method: "POST", body: "{}" });
  expect(result.status).toBe(302);
  expect(httpsRequest).toHaveBeenCalledTimes(1);
  const args = jest.mocked(httpsRequest).mock.calls[0];
  expect(String(args[0])).toBe("https://hooks.example.com/webhook");
  const lookup = args[1]!.lookup!;
  const callback = jest.fn();
  lookup("hooks.example.com", { all: false }, callback);
  expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  expect(response.destroy).toHaveBeenCalled();
});
