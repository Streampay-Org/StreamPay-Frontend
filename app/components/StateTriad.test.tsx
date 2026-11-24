/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import { StateTriad } from "./StateTriad";

describe("StateTriad", () => {
  it("renders loading state with default skeleton", () => {
    render(
      <StateTriad state="loading" loading={{ count: 2 }}>
        <div>Content</div>
      </StateTriad>
    );

    expect(screen.getByRole("status")).toBeInTheDocument();
    const skeletons = document.querySelectorAll(".skeleton");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders empty state", () => {
    render(
      <StateTriad state="empty">
        <div>Content</div>
      </StateTriad>
    );

    expect(screen.getByText("No data yet")).toBeInTheDocument();
    expect(screen.getByText("Nothing to show here")).toBeInTheDocument();
  });

  it("renders error state", () => {
    render(
      <StateTriad
        state="error"
        error={{
          heading: "Error Heading",
          message: "Error Message",
        }}
      >
        <div>Content</div>
      </StateTriad>
    );

    expect(screen.getByText("Error Heading")).toBeInTheDocument();
    expect(screen.getByText("Error Message")).toBeInTheDocument();
  });

  it("renders children when state is success", () => {
    render(
      <StateTriad state="success">
        <div data-testid="content">Actual Content</div>
      </StateTriad>
    );

    expect(screen.getByTestId("content")).toBeInTheDocument();
    expect(screen.getByText("Actual Content")).toBeInTheDocument();
  });
});
