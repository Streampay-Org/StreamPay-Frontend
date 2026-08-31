import { WalletBadge as OriginalWalletBadge } from "../WalletBadge";
import type { WalletBadgeProps, WalletState } from "../WalletBadge";
import { WalletBadgeSkeleton } from "./Skeleton";
import type { WalletBadgeSkeletonProps } from "./Skeleton";

const PRINT_STYLES = `
@media print {
  .wallet-badge-print-safe button,
  .wallet-badge-print-safe [role="button"],
  .wallet-badge-print-safe input,
  .wallet-badge-print-safe select,
  .wallet-badge-print-safe textarea,
  .wallet-badge-print-safe .secret,
  .wallet-badge-print-safe [data-secret] {
    display: none !important;
  }
}
`;

function WalletBadge(props: WalletBadgeProps) {
  return (
    <>
      <style>{PRINT_STYLES}</style>
      <div className="wallet-badge-print-safe" style={{ display: "contents" }}>
        <OriginalWalletBadge {...props} />
      </div>
    </>
  );
}

export { WalletBadge, WalletBadge as default };
export type { WalletBadgeProps, WalletState };
export { WalletBadgeSkeleton };
export type { WalletBadgeSkeletonProps };
