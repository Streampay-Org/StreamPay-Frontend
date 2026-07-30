/**
 * Network Badge Component
 * 
 * Displays the current Stellar network with safety labels to prevent
 * users from confusing testnet funds with real mainnet assets.
 * 
 * SECURITY: This is a critical financial safety feature.
 */

import { getConfig } from '../lib/config';
import type { StellarNetwork } from '../lib/config/stellar';

interface NetworkBadgeProps {
  className?: string;
  showLabel?: boolean;
  /** Optional: Override the network (for testing/preview only) */
  network?: StellarNetwork;
}

const networkStyles = {
  testnet: {
    backgroundColor: 'var(--system-warning-bg)',
    color: 'var(--system-warning-text)',
    borderColor: 'var(--system-warning-border)',
  },
  mainnet: {
    backgroundColor: 'var(--system-success-bg)',
    color: 'var(--system-success-text)',
    borderColor: 'var(--system-success-border)',
  },
} as const;

const networkLabels = {
  testnet: {
    icon: '⚠️',
    label: 'TESTNET ONLY',
    ariaLabel: 'Testnet network - not real funds',
  },
  mainnet: {
    icon: '🔒',
    label: 'Mainnet',
    ariaLabel: 'Mainnet network - real funds',
  },
} as const;

export function NetworkBadge({ 
  className = '', 
  showLabel = true,
  network: networkOverride 
}: NetworkBadgeProps) {
  try {
    const config = networkOverride 
      ? { network: { name: networkOverride, isProduction: networkOverride === 'mainnet' } } 
      : getConfig();
    const network = config.network.name as keyof typeof networkStyles;
    const styles = networkStyles[network];
    const labels = networkLabels[network];

    if (!showLabel) {
      return null;
    }

    return (
      <div
        className={`network-badge ${className}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.25rem 0.75rem',
          borderRadius: '999px',
          fontSize: '0.75rem',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          backgroundColor: styles.backgroundColor,
          color: styles.color,
          border: `1px solid ${styles.borderColor}`,
        }}
        role="status"
        aria-label={labels.ariaLabel}
      >
        <span style={{ fontSize: '1rem' }} aria-hidden="true">
          {labels.icon}
        </span>
        <span>{labels.label}</span>
      </div>
    );
  } catch (error) {
    // If config is not initialized, don't show the badge
    // This can happen during initial load or in error states
    return null;
  }
}

/**
 * Asset Label Component
 * 
 * Adds network-specific labels to asset displays to prevent
 * confusion between testnet and mainnet assets.
 */
interface AssetLabelProps {
  assetCode: string;
  className?: string;
  /** Optional: Override the network (for testing/preview only) */
  network?: StellarNetwork;
}

export function AssetLabel({ 
  assetCode, 
  className = '',
  network: networkOverride 
}: AssetLabelProps) {
  try {
    const config = networkOverride 
      ? { network: { name: networkOverride, assetLabel: networkOverride === 'testnet' ? 'TESTNET' : null } } 
      : getConfig();
    const label = config.network.assetLabel;

    if (!label) {
      return <span className={className}>{assetCode}</span>;
    }

    return (
      <span 
        className={className} 
        style={{ 
          display: 'inline-flex', 
          alignItems: 'center', 
          gap: '0.25rem' 
        }}
      >
        {assetCode}
        <span
          style={{
            fontSize: '0.7em',
            fontWeight: 600,
            color: 'var(--system-warning-text)',
            backgroundColor: 'var(--system-warning-bg)',
            padding: '0.1rem 0.4rem',
            borderRadius: '4px',
            textTransform: 'uppercase',
            border: '1px solid var(--system-warning-border)',
          }}
          aria-label={`${assetCode} on ${label}`}
        >
          {label}
        </span>
      </span>
    );
  } catch (error) {
    return <span className={className}>{assetCode}</span>;
  }
}
