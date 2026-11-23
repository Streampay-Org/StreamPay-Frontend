/** @jest-environment jsdom */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OrgPolicyPage from "./page";
import { ToastProvider } from "@/app/components/ToastProvider";
import { DEFAULT_STREAM_POLICY, type StreamPolicy } from "@/app/lib/org-types";

jest.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org-acme" }),
}));

function mockFetchResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const headerMap = new Map<string, string>(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    } as Headers,
    json: async () => body,
  } as Response;
}

function renderPage() {
  return render(
    <ToastProvider>
      <OrgPolicyPage />
    </ToastProvider>,
  );
}

describe("OrgPolicyPage", () => {
  const initialPolicy: StreamPolicy = {
    ...DEFAULT_STREAM_POLICY,
    requireApprovals: 2,
  };

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("loads and displays the policy matrix and approvals select, then saves changes with If-Match", async () => {
    const user = userEvent.setup();
    const updatedPolicy: StreamPolicy = {
      ...initialPolicy,
      canStop: ["owner", "pauser"],
      requireApprovals: 1,
    };

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        mockFetchResponse(
          {
            data: { orgId: "org-acme", policy: initialPolicy, updatedAt: "2026-04-01T00:00:00Z" },
            links: { self: "/api/orgs/org-acme/policy" },
          },
          200,
          { ETag: '"etag-v1"' },
        ),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(
          {
            data: { orgId: "org-acme", policy: updatedPolicy, updatedAt: "2026-04-02T00:00:00Z" },
            links: { self: "/api/orgs/org-acme/policy" },
          },
          200,
          { ETag: '"etag-v2"' },
        ),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    renderPage();

    const pauserStopCheckbox = await screen.findByLabelText("Allow pauser to stop");
    expect(pauserStopCheckbox).not.toBeChecked();

    await user.click(pauserStopCheckbox);
    expect(pauserStopCheckbox).toBeChecked();

    const approvalsSelect = screen.getByLabelText(/Required approvals/i);
    expect(approvalsSelect).toHaveValue("2");
    await user.selectOptions(approvalsSelect, "1");

    await user.click(screen.getByRole("button", { name: "Save Policy" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(putUrl).toBe("/api/orgs/org-acme/policy");
    expect(putInit.method).toBe("PUT");
    expect(putInit.headers["If-Match"]).toBe('"etag-v1"');
    expect(JSON.parse(putInit.body)).toEqual({ policy: updatedPolicy });

    expect(await screen.findByText("Stream policy saved.")).toBeInTheDocument();
  });

  it("shows accessible validation error when owner is unchecked and resets cleanly", async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn().mockResolvedValueOnce(
      mockFetchResponse(
        {
          data: { orgId: "org-acme", policy: initialPolicy, updatedAt: "2026-04-01T00:00:00Z" },
        },
        200,
        { ETag: '"etag-v1"' },
      ),
    ) as unknown as typeof fetch;

    renderPage();

    const ownerStopCheckbox = await screen.findByLabelText("Allow owner to stop");
    await user.click(ownerStopCheckbox);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/owner/i);
    expect(ownerStopCheckbox).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save Policy" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(ownerStopCheckbox).toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("handles 409 optimistic-lock conflict with ErrorBanner and reload action", async () => {
    const user = userEvent.setup();
    const latestPolicy: StreamPolicy = {
      ...initialPolicy,
      requireApprovals: 1,
    };

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        mockFetchResponse(
          { data: { orgId: "org-acme", policy: initialPolicy, updatedAt: "2026-04-01T00:00:00Z" } },
          200,
          { ETag: '"etag-v1"' },
        ),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(
          {
            error: {
              code: "STATE_CONFLICT",
              message: "Stream policy has been modified concurrently. Please reload and retry.",
              request_id: "req_conflict_1",
            },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(
          { data: { orgId: "org-acme", policy: latestPolicy, updatedAt: "2026-04-02T00:00:00Z" } },
          200,
          { ETag: '"etag-v2"' },
        ),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    renderPage();

    const pauserStopCheckbox = await screen.findByLabelText("Allow pauser to stop");
    await user.click(pauserStopCheckbox);
    await user.click(screen.getByRole("button", { name: "Save Policy" }));

    const banner = await screen.findByTestId("error-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent(/modified concurrently/i);

    await user.click(screen.getByRole("button", { name: "Reload latest policy" }));

    await waitFor(() => {
      expect(screen.getByLabelText(/Required approvals/i)).toHaveValue("1");
    });
    expect(screen.queryByTestId("error-banner")).not.toBeInTheDocument();
  });

  it("displays ErrorBanner accessibly when server returns 403 FORBIDDEN", async () => {
    const user = userEvent.setup();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        mockFetchResponse(
          { data: { orgId: "org-acme", policy: initialPolicy, updatedAt: "2026-04-01T00:00:00Z" } },
          200,
          { ETag: '"etag-v1"' },
        ),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(
          {
            error: {
              code: "FORBIDDEN",
              message: "Only org owners may update the stream policy.",
              request_id: "req_forbidden_1",
            },
          },
          403,
        ),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    renderPage();

    await user.click(await screen.findByLabelText("Allow pauser to stop"));
    await user.click(screen.getByRole("button", { name: "Save Policy" }));

    const banner = await screen.findByTestId("error-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent(/Only org owners may update the stream policy/i);
  });
});
