import { render, screen } from "@testing-library/react";
import Home from "./page";

describe("Home", () => {
  it("renders the updated stream action heading", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", {
        name: /manage payment streams with clear, consistent actions/i,
      }),
    ).toBeInTheDocument();
  });

  it("renders payment streaming tagline", () => {
    render(<Home />);
    expect(screen.getByText(/payment streaming on stellar/i)).toBeInTheDocument();
  });

  it("renders clear wallet and stream action CTAs", () => {
    render(<Home />);
    expect(screen.getByRole("link", { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view stream actions/i })).toBeInTheDocument();
  });

  it("renders the standardized stream action labels", () => {
    render(<Home />);
    for (const action of ["Start", "Pause", "Stop", "Settle", "Withdraw"]) {
      expect(screen.getByRole("heading", { name: action })).toBeInTheDocument();
    }
  });
});
