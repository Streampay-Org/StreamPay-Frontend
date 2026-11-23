/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { axe } from "jest-axe";

import { QuickDeposit } from "./QuickDeposit";

const XLM = 10_000_000n;

describe("QuickDeposit", () => {
  it("renders the card with a labelled amount input and presets", () => {
    render(<QuickDeposit onDeposit={jest.fn()} />);
    expect(screen.getByRole("heading", { name: /quick deposit/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/amount \(xlm\)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /10 xlm/i })).toBeInTheDocument();
  });

  it("fills the input when a preset chip is clicked", () => {
    render(<QuickDeposit onDeposit={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /50 xlm/i }));
    expect(screen.getByLabelText(/amount \(xlm\)/i)).toHaveValue("50");
  });

  it("shows a validation error for an empty amount", () => {
    render(<QuickDeposit onDeposit={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^deposit xlm$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/enter an amount/i);
  });

  it("shows a validation error for non-numeric input", () => {
    render(<QuickDeposit onDeposit={jest.fn()} />);
    fireEvent.change(screen.getByLabelText(/amount \(xlm\)/i), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /^deposit xlm$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/positive number/i);
  });

  it("rejects more than 7 decimal places", () => {
    render(<QuickDeposit onDeposit={jest.fn()} />);
    fireEvent.change(screen.getByLabelText(/amount \(xlm\)/i), {
      target: { value: "1.123456789" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^deposit xlm$/i }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("calls onDeposit with the trimmed amount on valid submit", async () => {
    const onDeposit = jest.fn().mockResolvedValue(undefined);
    render(<QuickDeposit onDeposit={onDeposit} />);
    fireEvent.change(screen.getByLabelText(/amount \(xlm\)/i), { target: { value: " 25.5 " } });
    fireEvent.click(screen.getByRole("button", { name: /^deposit xlm$/i }));
    await waitFor(() => expect(onDeposit).toHaveBeenCalledWith("25.5"));
  });

  it("surfaces an error when the deposit rejects", async () => {
    const onDeposit = jest.fn().mockRejectedValue(new Error("boom"));
    render(<QuickDeposit onDeposit={onDeposit} />);
    fireEvent.change(screen.getByLabelText(/amount \(xlm\)/i), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /^deposit xlm$/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/deposit failed/i));
  });

  describe("int64 bounds", () => {
    it("rejects an amount above the Stellar int64 maximum", () => {
      render(<QuickDeposit onDeposit={jest.fn()} />);
      fireEvent.change(screen.getByLabelText(/amount \(xlm\)/i), {
        target: { value: "922337203685.4775808" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^deposit xlm$/i }));
      expect(screen.getByRole("alert")).toHaveTextContent(/exceeds the stellar maximum/i);
    });

    it("accepts the exact Stellar int64 maximum", async () => {
      const onDeposit = jest.fn().mockResolvedValue(undefined);
      render(<QuickDeposit onDeposit={onDeposit} />);
      fireEvent.change(screen.getByLabelText(/amount \(xlm\)/i), {
        target: { value: "922337203685.4775807" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^deposit xlm$/i }));
      await waitFor(() => expect(onDeposit).toHaveBeenCalledWith("922337203685.4775807"));
    });
  });

  describe("balance-aware validation", () => {
    it("rejects an amount above the spendable balance and names it", () => {
      render(
        <QuickDeposit onDeposit={jest.fn()} availableStroops={100n * XLM} reserveStroops={15n * XLM / 10n} />,
      );
      fireEvent.change(screen.getByLabelText(/amount \(xlm\)/i), { target: { value: "99" } });
      fireEvent.click(screen.getByRole("button", { name: /^deposit xlm$/i }));
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(/98\.5/);
      expect(alert).toHaveTextContent(/network reserve/i);
    });

    it("accepts an amount equal to the spendable balance", async () => {
      const onDeposit = jest.fn().mockResolvedValue(undefined);
      render(
        <QuickDeposit
          onDeposit={onDeposit}
          availableStroops={100n * XLM}
          reserveStroops={15n * XLM / 10n}
        />,
      );
      fireEvent.change(screen.getByLabelText(/amount \(xlm\)/i), { target: { value: "98.5" } });
      fireEvent.click(screen.getByRole("button", { name: /^deposit xlm$/i }));
      await waitFor(() => expect(onDeposit).toHaveBeenCalledWith("98.5"));
    });

    it("fills the spendable amount from the Max chip", () => {
      render(
        <QuickDeposit onDeposit={jest.fn()} availableStroops={100n * XLM} reserveStroops={15n * XLM / 10n} />,
      );
      fireEvent.click(screen.getByRole("button", { name: /max/i }));
      expect(screen.getByLabelText(/amount \(xlm\)/i)).toHaveValue("98.5");
    });

    it("disables presets above the spendable balance and explains why", () => {
      render(
        <QuickDeposit
          onDeposit={jest.fn()}
          availableStroops={50n * XLM}
          reserveStroops={0n}
        />,
      );
      const preset = screen.getByRole("button", { name: /100 xlm/i });
      expect(preset).toBeDisabled();
      expect(preset).toHaveAccessibleDescription(/spendable balance/i);
    });

    it("does not render the Max chip when no balance is supplied", () => {
      render(<QuickDeposit onDeposit={jest.fn()} />);
      expect(screen.queryByRole("button", { name: /max/i })).not.toBeInTheDocument();
    });
  });

  describe("pending state", () => {
    it("disables the presets while a deposit is pending", async () => {
      let resolveDeposit: () => void = () => undefined;
      const onDeposit = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDeposit = resolve;
          }),
      );

      render(<QuickDeposit onDeposit={onDeposit} />);
      fireEvent.change(screen.getByLabelText(/amount \(xlm\)/i), { target: { value: "10" } });
      fireEvent.click(screen.getByRole("button", { name: /^deposit xlm$/i }));

      await waitFor(() => expect(screen.getByRole("button", { name: /10 xlm/i })).toBeDisabled());
      expect(screen.getByRole("button", { name: /50 xlm/i })).toBeDisabled();

      resolveDeposit();
      await waitFor(() => expect(screen.getByRole("button", { name: /10 xlm/i })).not.toBeDisabled());
    });

    it("keeps the entered amount when the deposit rejects", async () => {
      const onDeposit = jest.fn().mockRejectedValue(new Error("boom"));
      render(<QuickDeposit onDeposit={onDeposit} />);
      fireEvent.change(screen.getByLabelText(/amount \(xlm\)/i), { target: { value: "10" } });
      fireEvent.click(screen.getByRole("button", { name: /^deposit xlm$/i }));

      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/deposit failed/i));
      expect(screen.getByLabelText(/amount \(xlm\)/i)).toHaveValue("10");
    });

    it("clears the amount when the deposit resolves", async () => {
      const onDeposit = jest.fn().mockResolvedValue(undefined);
      render(<QuickDeposit onDeposit={onDeposit} />);
      fireEvent.change(screen.getByLabelText(/amount \(xlm\)/i), { target: { value: "10" } });
      fireEvent.click(screen.getByRole("button", { name: /^deposit xlm$/i }));

      await waitFor(() => expect(onDeposit).toHaveBeenCalledWith("10"));
      await waitFor(() => expect(screen.getByLabelText(/amount \(xlm\)/i)).toHaveValue(""));
    });
  });

  it("has no serious axe violations", async () => {
    const { container } = render(
      <QuickDeposit onDeposit={jest.fn()} availableStroops={100n * XLM} reserveStroops={15n * XLM / 10n} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
