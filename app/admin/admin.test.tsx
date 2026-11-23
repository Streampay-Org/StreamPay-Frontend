/** @jest-environment jsdom */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import AdminLayout from "./layout";
import AdminDashboardPage from "./page";
import AdminQuotasPage from "./quotas/page";
import { encodeStellarPublicKey } from "@/app/lib/stellar-address";

jest.mock("next/navigation", () => ({
  usePathname: () => "/admin",
}));

const VALID_STELLAR_ADDRESS = encodeStellarPublicKey(new Uint8Array(32).fill(7));

function mockJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe("AdminLayout", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("renders 403 Forbidden and hides children for non-admins", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse({ error: { code: "FORBIDDEN", message: "Admin required" } }, 403),
    );

    render(
      <AdminLayout>
        <div data-testid="secret-admin-child">Secret Admin Content</div>
      </AdminLayout>,
    );

    await waitFor(() => {
      expect(screen.getByText(/403 — Forbidden/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("secret-admin-child")).not.toBeInTheDocument();
  });

  it("renders children when admin check succeeds", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse({ data: { health: { total: 5 } } }, 200),
    );

    render(
      <AdminLayout>
        <div data-testid="secret-admin-child">Secret Admin Content</div>
      </AdminLayout>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("secret-admin-child")).toBeInTheDocument();
    });
    expect(screen.getByText("Admin Console")).toBeInTheDocument();
  });
});

describe("AdminDashboardPage", () => {
  const defaultPause = {
    data: { paused: false, pausedAt: null, adminAddress: "GADMIN" },
  };
  const defaultBreakers = {
    data: {
      indexer: { open: false, updatedAt: null, updatedBy: null },
      webhook: { open: false, updatedAt: null, updatedBy: null },
    },
  };
  const defaultHealth = {
    data: {
      health: {
        total: 10,
        byStatus: { active: 8, paused: 2 },
        failureRatePct: 0,
        oldestStuckAt: null,
        checkedAt: "2026-05-01T00:00:00Z",
      },
    },
  };
  const defaultJobs = {
    data: {
      queues: {
        "settlement-queue": { count: 2, deadLettered: 0 },
        "webhook-queue": { count: 1, deadLettered: 0 },
        "retry-queue": { count: 0, deadLettered: 0 },
      },
      totals: { total: 3, pending: 3, failed: 0, deadLettered: 0 },
    },
  };

  function setupDashboardFetch(overrides?: {
    pause?: unknown;
    postResponse?: Response;
  }) {
    (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(
          overrides?.postResponse ??
            mockJsonResponse({ data: { paused: true }, auditRequestId: "audit-req-123" }, 200),
        );
      }
      if (url === "/api/admin/pause") {
        return Promise.resolve(mockJsonResponse(overrides?.pause ?? defaultPause));
      }
      if (url === "/api/admin/circuit-breaker") {
        return Promise.resolve(mockJsonResponse(defaultBreakers));
      }
      if (url === "/api/admin/streams/health") {
        return Promise.resolve(mockJsonResponse(defaultHealth));
      }
      if (url === "/api/admin/jobs") {
        return Promise.resolve(mockJsonResponse(defaultJobs));
      }
      return Promise.resolve(mockJsonResponse({}, 404));
    });
  }

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("renders dashboard cards and toggles global pause with mandatory reason", async () => {
    setupDashboardFetch();
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Global Pause")).toBeInTheDocument();
    });
    expect(screen.getByText("Circuit Breakers")).toBeInTheDocument();
    expect(screen.getByText("Stream Health")).toBeInTheDocument();
    expect(screen.getByText("Job Queue Depth")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Activate Global Pause/i }));

    expect(screen.getByText(/Blast radius:/i)).toBeInTheDocument();
    const confirmBtn = screen.getByRole("button", { name: /^Confirm$/i });
    expect(confirmBtn).toBeDisabled();

    const textarea = screen.getByLabelText(/Audit Reason/i);
    fireEvent.change(textarea, { target: { value: "short" } });
    expect(confirmBtn).toBeDisabled();

    fireEvent.change(textarea, {
      target: { value: "Emergency incident pause for investigation" },
    });
    expect(confirmBtn).not.toBeDisabled();

    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText("audit-req-123")).toBeInTheDocument();
    });
  });

  it("validates sender address before opening pause-by-sender modal", async () => {
    setupDashboardFetch();
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Sender Stellar Address/i)).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/Sender Stellar Address/i);
    fireEvent.change(input, { target: { value: "INVALID_ADDRESS" } });
    fireEvent.click(screen.getByRole("button", { name: /Pause Sender Streams/i }));

    expect(screen.getByText(/Enter a valid Stellar public key/i)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: VALID_STELLAR_ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: /Pause Sender Streams/i }));

    expect(screen.getByText(/Pause Streams by Sender/i)).toBeInTheDocument();
    expect(screen.getByText(/Blast radius:/i)).toBeInTheDocument();
  });
});

describe("AdminQuotasPage", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("lists, creates, and deletes quotas", async () => {
    const initialQuotas = [
      {
        id: "q-1",
        scope: "org" as const,
        subject: "org-acme",
        maxActiveStreams: 50,
        maxMonthlyVolumeStroops: 1000000,
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      },
    ];

    (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/admin/quotas" && (!init?.method || init.method === "GET")) {
        return Promise.resolve(mockJsonResponse({ data: initialQuotas }));
      }
      if (url === "/api/admin/quotas" && init?.method === "POST") {
        return Promise.resolve(mockJsonResponse({ data: initialQuotas[0] }, 201));
      }
      if (url === "/api/admin/quotas/q-1" && init?.method === "DELETE") {
        return Promise.resolve({ ok: true, status: 204, json: async () => ({}) } as Response);
      }
      return Promise.resolve(mockJsonResponse({}, 404));
    });

    render(<AdminQuotasPage />);

    await waitFor(() => {
      expect(screen.getByText("org-acme")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /New Quota/i }));
    fireEvent.change(screen.getByLabelText(/Subject/i), {
      target: { value: "org-beta" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create Quota/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/quotas",
        expect.objectContaining({ method: "POST" }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm Delete/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/quotas/q-1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
