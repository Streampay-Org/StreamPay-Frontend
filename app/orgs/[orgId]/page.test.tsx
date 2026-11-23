import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe, toHaveNoViolations } from "jest-axe";
import { DEFAULT_STREAM_POLICY } from "@/app/lib/org-types";
import OrgDetailPage from "./page";
import { WALLET_ADDRESS_STORAGE_KEY } from "../useOrgApi";

expect.extend(toHaveNoViolations);

let mockOrgId = "org-acme";

jest.mock("next/navigation", () => ({
  useParams: () => ({ orgId: mockOrgId }),
}));

const OWNER_WALLET = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZLPXE";
const SECOND_WALLET = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGYWDEAVQBMJ7WGNB55IVJV";

const SAMPLE_ORG = {
  id: "org-acme",
  name: "Acme Treasury",
  members: [
    {
      walletAddress: OWNER_WALLET,
      role: "owner" as const,
      addedAt: "2026-04-01T00:00:00.000Z",
    },
  ],
  policy: DEFAULT_STREAM_POLICY,
  ownedStreams: [],
  tokenAllowlist: [],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-10T00:00:00.000Z",
};

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

function mockInitialLoad(tokens: string[] = []) {
  (global.fetch as jest.Mock)
    .mockResolvedValueOnce(mockJsonResponse({ data: { ...SAMPLE_ORG, tokenAllowlist: tokens } }))
    .mockResolvedValueOnce(mockJsonResponse({ data: SAMPLE_ORG.members }))
    .mockResolvedValueOnce(
      mockJsonResponse({
        data: { orgId: SAMPLE_ORG.id, tokens, enabled: tokens.length > 0 },
      }),
    );
}

describe("OrgDetailPage (/orgs/[orgId])", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockOrgId = "org-acme";
    window.localStorage.clear();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders read-only view for non-owners with no mutating controls and passes axe", async () => {
    window.localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, SECOND_WALLET);
    mockInitialLoad([]);

    const { container } = render(<OrgDetailPage />);

    expect(
      await screen.findByRole("heading", { name: "Acme Treasury" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("members-readonly-note")).toBeInTheDocument();
    expect(screen.getByTestId("allowlist-readonly-note")).toBeInTheDocument();
    expect(screen.getByTestId("allowlist-empty")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add member/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add token/i })).not.toBeInTheDocument();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("renders 404 state for unknown org", async () => {
    mockOrgId = "org-missing";
    (global.fetch as jest.Mock).mockResolvedValue(
      mockJsonResponse(
        {
          error: {
            code: "ORG_NOT_FOUND",
            message: "Org 'org-missing' not found.",
            request_id: "req-404",
          },
        },
        404,
      ),
    );

    render(<OrgDetailPage />);

    expect(
      await screen.findByRole("heading", { name: /Organisation not found/i }),
    ).toBeInTheDocument();
  });

  it("handles network failure with retry", async () => {
    const user = userEvent.setup();
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new TypeError("Network error"))
      .mockRejectedValueOnce(new TypeError("Network error"))
      .mockRejectedValueOnce(new TypeError("Network error"));

    render(<OrgDetailPage />);

    expect(await screen.findByTestId("error-banner")).toBeInTheDocument();

    mockInitialLoad([]);
    await user.click(screen.getByRole("button", { name: /Retry/i }));

    expect(
      await screen.findByRole("heading", { name: "Acme Treasury" }),
    ).toBeInTheDocument();
  });

  it("rejects malformed Stellar address client-side, adds member, handles duplicate 200, and displays 403 FORBIDDEN", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, OWNER_WALLET);
    mockInitialLoad([]);

    render(<OrgDetailPage />);
    await screen.findByRole("heading", { name: "Acme Treasury" });

    const walletInput = screen.getByLabelText(/Stellar wallet address/i);
    const roleSelect = screen.getByLabelText(/^Role$/i);
    const addBtn = screen.getByRole("button", { name: "Add member" });

    // Malformed address rejected client-side without calling fetch
    await user.type(walletInput, "NOT_A_STELLAR_KEY");
    await user.click(addBtn);
    expect(
      screen.getByText(/valid 56-character Stellar public key/i),
    ).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(3);

    // Valid add (201)
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse(
        {
          data: {
            walletAddress: SECOND_WALLET,
            role: "settler",
            addedAt: "2026-04-12T00:00:00.000Z",
          },
        },
        201,
      ),
    );

    await user.clear(walletInput);
    await user.type(walletInput, SECOND_WALLET);
    await user.selectOptions(roleSelect, "settler");
    await user.click(addBtn);

    expect(await screen.findByText(SECOND_WALLET)).toBeInTheDocument();
    expect(screen.getByTestId("org-detail-live-region")).toHaveTextContent(
      `Added ${SECOND_WALLET} as settler.`,
    );

    // Duplicate member (200)
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse(
        {
          data: {
            walletAddress: SECOND_WALLET,
            role: "settler",
            addedAt: "2026-04-12T00:00:00.000Z",
          },
        },
        200,
      ),
    );

    await user.type(walletInput, SECOND_WALLET);
    await user.click(addBtn);

    await waitFor(() => {
      expect(screen.getByTestId("org-detail-live-region")).toHaveTextContent(
        `Member ${SECOND_WALLET} is already in this organisation (settler).`,
      );
    });
    expect(screen.getAllByText(SECOND_WALLET)).toHaveLength(1);

    // Server-side 403 FORBIDDEN displayed as readable error banner
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse(
        {
          error: {
            code: "FORBIDDEN",
            message: "Only org owners may add members.",
            request_id: "req-403",
          },
        },
        403,
      ),
    );

    await user.type(walletInput, OWNER_WALLET);
    await user.click(addBtn);

    const banner = await screen.findByTestId("error-banner");
    expect(banner).toHaveAttribute("data-error-code", "FORBIDDEN");
  });

  it("normalises and adds a token, and removes a token with confirmation step", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, OWNER_WALLET);
    mockInitialLoad([]);

    render(<OrgDetailPage />);
    await screen.findByRole("heading", { name: "Acme Treasury" });

    const tokenInput = screen.getByLabelText(/Add token/i);
    const addTokenBtn = screen.getByRole("button", { name: "Add token" });

    // Add "native" -> normalised to "XLM"
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse(
        {
          data: { orgId: "org-acme", tokens: ["XLM"], enabled: true, added: true },
        },
        201,
      ),
    );

    await user.type(tokenInput, "native");
    await user.click(addTokenBtn);

    expect(await screen.findByText("XLM")).toBeInTheDocument();
    expect(screen.getByTestId("org-detail-live-region")).toHaveTextContent(
      "Added token XLM to allowlist.",
    );

    // Verify normalised payload and Actor-Wallet-Address header
    const postCall = (global.fetch as jest.Mock).mock.calls[3];
    expect(postCall[0]).toBe("/api/orgs/org-acme/token-allowlist");
    expect(JSON.parse(postCall[1].body)).toEqual({ token: "XLM" });
    expect(postCall[1].headers["Actor-Wallet-Address"]).toBe(OWNER_WALLET);

    // Remove token with confirm step
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockJsonResponse({
        data: { orgId: "org-acme", tokens: [], enabled: false, removed: true },
      }),
    );

    await user.click(screen.getByRole("button", { name: "Remove XLM" }));
    await user.click(screen.getByRole("button", { name: "Confirm remove XLM" }));

    expect(await screen.findByTestId("allowlist-empty")).toBeInTheDocument();
    expect(screen.getByTestId("org-detail-live-region")).toHaveTextContent(
      "Removed token XLM from allowlist.",
    );
  });
});
