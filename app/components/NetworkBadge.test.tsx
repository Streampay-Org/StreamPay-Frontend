/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { NetworkBadge, AssetLabel } from './NetworkBadge';
import { getConfig, resetConfigCache } from '../lib/config';

// Mock the config module
jest.mock('../lib/config', () => ({
  getConfig: jest.fn(),
  resetConfigCache: jest.fn(),
}));

const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;

describe('NetworkBadge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders testnet badge correctly', () => {
    mockGetConfig.mockReturnValue({
      network: {
        name: 'testnet',
        isProduction: false,
        networkPassphrase: '',
        horizonUrl: '',
        assetLabel: 'TESTNET',
        explorerUrl: '',
      },
      jwtSecret: '',
      serviceName: '',
      environment: '',
      allowedOrigins: [],
      anomalyThresholds: { creationBurstLimit: 0, settleRateLimit: 0, cancelBurstLimit: 0 },
    });

    render(<NetworkBadge />);
    
    expect(screen.getByText('TESTNET ONLY')).toBeInTheDocument();
    expect(screen.getByText('⚠️')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Testnet network - not real funds');
  });

  it('renders mainnet badge correctly', () => {
    mockGetConfig.mockReturnValue({
      network: {
        name: 'mainnet',
        isProduction: true,
        networkPassphrase: '',
        horizonUrl: '',
        assetLabel: null,
        explorerUrl: '',
      },
      jwtSecret: '',
      serviceName: '',
      environment: '',
      allowedOrigins: [],
      anomalyThresholds: { creationBurstLimit: 0, settleRateLimit: 0, cancelBurstLimit: 0 },
    });

    render(<NetworkBadge />);
    
    expect(screen.getByText('Mainnet')).toBeInTheDocument();
    expect(screen.getByText('🔒')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Mainnet network - real funds');
  });

  it('respects network override prop', () => {
    render(<NetworkBadge network="testnet" />);
    expect(screen.getByText('TESTNET ONLY')).toBeInTheDocument();
    
    render(<NetworkBadge network="mainnet" />);
    expect(screen.getByText('Mainnet')).toBeInTheDocument();
  });

  it('returns null when showLabel is false', () => {
    mockGetConfig.mockReturnValue({
      network: {
        name: 'testnet',
        isProduction: false,
        networkPassphrase: '',
        horizonUrl: '',
        assetLabel: 'TESTNET',
        explorerUrl: '',
      },
      jwtSecret: '',
      serviceName: '',
      environment: '',
      allowedOrigins: [],
      anomalyThresholds: { creationBurstLimit: 0, settleRateLimit: 0, cancelBurstLimit: 0 },
    });

    const { container } = render(<NetworkBadge showLabel={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when config fails to load', () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error('Config not loaded');
    });

    const { container } = render(<NetworkBadge />);
    expect(container.firstChild).toBeNull();
  });
});

describe('AssetLabel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders asset with testnet label', () => {
    mockGetConfig.mockReturnValue({
      network: {
        name: 'testnet',
        isProduction: false,
        networkPassphrase: '',
        horizonUrl: '',
        assetLabel: 'TESTNET',
        explorerUrl: '',
      },
      jwtSecret: '',
      serviceName: '',
      environment: '',
      allowedOrigins: [],
      anomalyThresholds: { creationBurstLimit: 0, settleRateLimit: 0, cancelBurstLimit: 0 },
    });

    render(<AssetLabel assetCode="XLM" />);
    
    expect(screen.getByText('XLM')).toBeInTheDocument();
    expect(screen.getByText('TESTNET')).toBeInTheDocument();
  });

  it('renders asset without label for mainnet', () => {
    mockGetConfig.mockReturnValue({
      network: {
        name: 'mainnet',
        isProduction: true,
        networkPassphrase: '',
        horizonUrl: '',
        assetLabel: null,
        explorerUrl: '',
      },
      jwtSecret: '',
      serviceName: '',
      environment: '',
      allowedOrigins: [],
      anomalyThresholds: { creationBurstLimit: 0, settleRateLimit: 0, cancelBurstLimit: 0 },
    });

    render(<AssetLabel assetCode="XLM" />);
    
    expect(screen.getByText('XLM')).toBeInTheDocument();
    expect(screen.queryByText('TESTNET')).not.toBeInTheDocument();
  });

  it('respects network override prop', () => {
    const { rerender } = render(<AssetLabel assetCode="XLM" network="testnet" />);
    expect(screen.getByText('XLM')).toBeInTheDocument();
    expect(screen.getByText('TESTNET')).toBeInTheDocument();
    
    rerender(<AssetLabel assetCode="XLM" network="mainnet" />);
    expect(screen.getByText('XLM')).toBeInTheDocument();
    expect(screen.queryByText('TESTNET')).not.toBeInTheDocument();
  });

  it('returns just the asset code when config fails to load', () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error('Config not loaded');
    });

    render(<AssetLabel assetCode="XLM" />);
    expect(screen.getByText('XLM')).toBeInTheDocument();
  });
});
