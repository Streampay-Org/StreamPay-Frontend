import React from "react";
import { render } from "@testing-library/react";
import { Skeleton } from "./Skeleton";

describe("Skeleton component", () => {
  it("renders with default props", () => {
    const { container } = render(<Skeleton />);
    const skeleton = container.firstChild as HTMLElement;
    
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveClass("skeleton");
    expect(skeleton).toHaveStyle({ width: "100%", height: "1rem" });
    expect(skeleton).toHaveAttribute("aria-hidden", "true");
  });

  it("applies custom width and height", () => {
    const { container } = render(<Skeleton width="50%" height="2rem" />);
    const skeleton = container.firstChild as HTMLElement;
    
    expect(skeleton).toHaveStyle({ width: "50%", height: "2rem" });
  });

  it("applies number width and height as pixels", () => {
    const { container } = render(<Skeleton width={100} height={50} />);
    const skeleton = container.firstChild as HTMLElement;
    
    expect(skeleton).toHaveStyle({ width: "100px", height: "50px" });
  });

  it("applies circular styling when circle prop is true", () => {
    const { container } = render(<Skeleton circle />);
    const skeleton = container.firstChild as HTMLElement;
    
    expect(skeleton).toHaveStyle({ borderRadius: "50%" });
  });

  it("appends custom className", () => {
    const { container } = render(<Skeleton className="custom-class" />);
    const skeleton = container.firstChild as HTMLElement;
    
    expect(skeleton).toHaveClass("skeleton custom-class");
  });

  it("applies variant class and ignores default width/height", () => {
    const { container } = render(<Skeleton variant="button" />);
    const skeleton = container.firstChild as HTMLElement;
    
    expect(skeleton).toHaveClass("skeleton skeleton--button");
    // When variant is used, inline style for width/height shouldn't be the default 100% / 1rem
    expect(skeleton.style.width).toBe("");
    expect(skeleton.style.height).toBe("");
  });

  it("allows overriding width/height even when variant is provided", () => {
    const { container } = render(<Skeleton variant="button" width="200px" />);
    const skeleton = container.firstChild as HTMLElement;
    
    expect(skeleton).toHaveClass("skeleton skeleton--button");
    expect(skeleton).toHaveStyle({ width: "200px" });
    expect(skeleton.style.height).toBe(""); // Height should remain unset
  });
});
