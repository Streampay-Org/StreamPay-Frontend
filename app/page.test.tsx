import { fireEvent, render, screen } from "@testing-library/react";
import Home from "./page";

describe("Home", () => {
  it("renders StreamPay heading", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: /streampay/i })).toBeInTheDocument();
  });

  it("renders payment streaming tagline", () => {
    render(<Home />);
    expect(screen.getByText(/payment streaming on stellar/i)).toBeInTheDocument();
  });

  it("opens the wallet selection modal", () => {
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: /select wallet/i }));

    expect(screen.getByRole("dialog", { name: /choose a wallet/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /freighter/i })).toBeInTheDocument();
  });
});
