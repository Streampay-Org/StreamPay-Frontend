import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe, toHaveNoViolations } from "jest-axe";
import { DEFAULT_STREAM_POLICY } from "@/app/lib/org-types";
import OrgsPage from "./page";

expect.extend(toHaveNoViolations);

const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const VALID_WALLET = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZLPXE";

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

describe("OrgsPage (/orgs)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockPush.mockReset();
    window.localStorage.clear();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders loading skeleton then lists organisations", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse({
        data: [
          {
            id: "org-acme",
            name: "Acme Treasury",
            memberCount: 3,
            policy: DEFAULT_STREAM_POLICY,
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
        meta: { total: 1 },
      }),
    );

    const { container } = render(<OrgsPage />);
    expect(screen.getByTestId("orgs-loading")).toBeInTheDocument();

    const link = await screen.findByRole("link", { name: "Acme Treasury" });
    expect(link).toHaveAttribute("href", "/orgs/org-acme");
    expect(screen.getByText("3 members")).toBeInTheDocument();
    expect(screen.getByText(/1-step \(immediate\)/i)).toBeInTheDocument();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("renders empty state when no organisations exist", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse({ data: [], meta: { total: 0 } }),
    );

    render(<OrgsPage />);

    expect(
      await screen.findByRole("heading", { name: /No organisations yet/i }),
    ).toBeInTheDocument();
  });

  it("renders error banner on network failure and retries successfully", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: [
            {
              id: "org-retry",
              name: "Retry Org",
              memberCount: 1,
              policy: DEFAULT_STREAM_POLICY,
              createdAt: "2026-04-01T00:00:00.000Z",
              updatedAt: "2026-04-01T00:00:00.000Z",
            },
          ],
          meta: { total: 1 },
        }),
      );

    render(<OrgsPage />);

    expect(await screen.findByTestId("error-banner")).toBeInTheDocument();
    const retryBtn = screen.getByRole("button", { name: /Retry/i });
    await user.click(retryBtn);

    expect(await screen.findByRole("link", { name: "Retry Org" })).toBeInTheDocument();
  });

  it("validates create org dialog, surfaces 422 field errors inline, and navigates on success", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockJsonResponse({ data: [], meta: { total: 0 } }))
      .mockResolvedValueOnce(
        mockJsonResponse(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Field 'name' is already taken.",
              request_id: "req-422",
            },
          },
          422,
        ),
      )
      .mockResolvedValueOnce(
        mockJsonResponse(
          {
            data: {
              id: "org-new123",
              name: "New Org",
              members: [
                {
                  walletAddress: VALID_WALLET,
                  role: "owner",
                  addedAt: "2026-04-12T00:00:00.000Z",
                },
              ],
              policy: DEFAULT_STREAM_POLICY,
              createdAt: "2026-04-12T00:00:00.000Z",
              updatedAt: "2026-04-12T00:00:00.000Z",
            },
          },
          201,
        ),
      );

    render(<OrgsPage />);
    await screen.findByRole("heading", { name: /No organisations yet/i });

    const headerCreateBtn = screen.getAllByRole("button", { name: "Create org" })[0];
    await user.click(headerCreateBtn);

    const dialog = screen.getByRole("dialog");
    const nameInput = within(dialog).getByLabelText(/Organisation name/i);
    const walletInput = within(dialog).getByLabelText(/Owner wallet address/i);
    const submitBtn = within(dialog).getByRole("button", { name: "Create" });

    // Malformed wallet rejected client-side
    await user.type(nameInput, "New Org");
    await user.type(walletInput, "INVALID_WALLET");
    await user.click(submitBtn);

    expect(
      within(dialog).getByText(/valid 56-character Stellar public key/i),
    ).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Fix wallet -> triggers 422 inline error
    await user.clear(walletInput);
    await user.type(walletInput, VALID_WALLET);
    await user.click(submitBtn);

    expect(
      await within(dialog).findByText("Field 'name' is already taken."),
    ).toBeInTheDocument();

    // Retry submit -> succeeds and navigates
    await user.click(submitBtn);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/orgs/org-new123");
    });
  });
});
