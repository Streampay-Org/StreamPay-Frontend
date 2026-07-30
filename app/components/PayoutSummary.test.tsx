import { render, screen } from "@testing-library/react";
import { PayoutSummary } from "./PayoutSummary";

describe("PayoutSummary", () => {
  it("renders a polished GrantFox summary with accessible labels", () => {
    render(
      <PayoutSummary
        campaignName="GrantFox FWC26"
        totalAmount="12,450.00"
        tokenSymbol="USDC"
        recipientCount={24}
      />,
    );

    expect(screen.getByRole("heading", { name: /grantfox payout summary/i })).toBeInTheDocument();
    expect(screen.getByText(/grantfox fwc26/i)).toBeInTheDocument();
    expect(screen.getByText(/12,450.00 usdc/i)).toBeInTheDocument();
    expect(screen.getByText(/24 recipients/i)).toBeInTheDocument();
  });

  it("uses singular recipient wording for a single-recipient payout", () => {
    render(
      <PayoutSummary
        campaignName="GrantFox FWC26"
        totalAmount="1,000.00"
        recipientCount={1}
      />,
    );

    expect(screen.getByText(/1 recipient/i)).toBeInTheDocument();
  });
});
