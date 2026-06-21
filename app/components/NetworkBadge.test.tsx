/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import { NetworkBadge, AssetLabel } from "./NetworkBadge";

// Mock getConfig so tests are hermetic and don't depend on environment bootstrap
jest.mock("../lib/config", () => ({
  getConfig: jest.fn(),
}));

import { getConfig } from "../lib/config";
const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;

function testnetConfig() {
  return {
    network: { name: "testnet", isProduction: false, assetLabel: "TESTNET" },
  } as ReturnType<typeof getConfig>;
}

function mainnetConfig() {
  return {
    network: { name: "mainnet", isProduction: true, assetLabel: "" },
  } as ReturnType<typeof getConfig>;
}

describe("NetworkBadge", () => {
  afterEach(() => jest.resetAllMocks());

  it("renders TESTNET ONLY badge on testnet", () => {
    mockGetConfig.mockReturnValue(testnetConfig());
    render(<NetworkBadge />);
    expect(screen.getByText("TESTNET ONLY")).toBeInTheDocument();
  });

  it("renders Mainnet badge on mainnet", () => {
    mockGetConfig.mockReturnValue(mainnetConfig());
    render(<NetworkBadge />);
    expect(screen.getByText("Mainnet")).toBeInTheDocument();
  });

  it("renders nothing when showLabel is false", () => {
    mockGetConfig.mockReturnValue(testnetConfig());
    const { container } = render(<NetworkBadge showLabel={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when getConfig throws", () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("Config not initialized");
    });
    const { container } = render(<NetworkBadge />);
    expect(container.firstChild).toBeNull();
  });

  it("accepts a custom className", () => {
    mockGetConfig.mockReturnValue(testnetConfig());
    const { container } = render(<NetworkBadge className="my-class" />);
    expect(container.querySelector(".network-badge.my-class")).toBeInTheDocument();
  });
});

describe("AssetLabel", () => {
  afterEach(() => jest.resetAllMocks());

  it("renders asset code with TESTNET label on testnet", () => {
    mockGetConfig.mockReturnValue(testnetConfig());
    render(<AssetLabel assetCode="XLM" />);
    expect(screen.getByText("XLM")).toBeInTheDocument();
    expect(screen.getByText("TESTNET")).toBeInTheDocument();
  });

  it("renders asset code only when assetLabel is empty", () => {
    mockGetConfig.mockReturnValue(mainnetConfig());
    render(<AssetLabel assetCode="XLM" />);
    expect(screen.getByText("XLM")).toBeInTheDocument();
    expect(screen.queryByText("TESTNET")).not.toBeInTheDocument();
  });

  it("renders asset code only when getConfig throws", () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("Config not initialized");
    });
    render(<AssetLabel assetCode="USDC" />);
    expect(screen.getByText("USDC")).toBeInTheDocument();
  });
});
