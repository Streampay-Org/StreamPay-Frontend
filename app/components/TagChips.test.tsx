/**
 * @jest-environment jsdom
 */

import { render, fireEvent } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import { TagChips } from "./TagChips";

describe("TagChips", () => {
  it("renders nothing when there are no tags", () => {
    const { container } = render(
      <TagChips tags={[]} selectedTag={null} onTagClick={jest.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders a chip per tag with a filter group label", () => {
    render(<TagChips tags={["design", "vendor"]} selectedTag={null} onTagClick={jest.fn()} />);

    expect(screen.getByRole("group", { name: /filter by tag/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "design" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "vendor" })).toBeInTheDocument();
  });

  it("selects a tag on click and marks it pressed", () => {
    const onTagClick = jest.fn();
    render(<TagChips tags={["design", "vendor"]} selectedTag={null} onTagClick={onTagClick} />);

    fireEvent.click(screen.getByRole("button", { name: "design" }));

    expect(onTagClick).toHaveBeenCalledWith("design");
  });

  it("marks the selected tag as pressed and shows a clear button", () => {
    render(<TagChips tags={["design", "vendor"]} selectedTag="design" onTagClick={jest.fn()} />);

    expect(screen.getByRole("button", { name: "design" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "vendor" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /clear tag filter/i })).toBeInTheDocument();
  });

  it("clicking the active tag again deselects it", () => {
    const onTagClick = jest.fn();
    render(<TagChips tags={["design", "vendor"]} selectedTag="design" onTagClick={onTagClick} />);

    fireEvent.click(screen.getByRole("button", { name: "design" }));

    expect(onTagClick).toHaveBeenCalledWith(null);
  });

  it("clicking the clear button deselects the tag", () => {
    const onTagClick = jest.fn();
    render(<TagChips tags={["design", "vendor"]} selectedTag="design" onTagClick={onTagClick} />);

    fireEvent.click(screen.getByRole("button", { name: /clear tag filter/i }));

    expect(onTagClick).toHaveBeenCalledWith(null);
  });

  it("does not render a clear button when no tag is selected", () => {
    render(<TagChips tags={["design"]} selectedTag={null} onTagClick={jest.fn()} />);

    expect(screen.queryByRole("button", { name: /clear tag filter/i })).not.toBeInTheDocument();
  });
});
