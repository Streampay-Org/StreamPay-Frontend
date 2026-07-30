/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
const { screen, within } = require("@testing-library/react") as any;
import HelpPage from "./page";

describe("HelpPage", () => {
  it("renders the page shell and hero", () => {
    render(<HelpPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: /help.*faq/i }),
    ).toBeInTheDocument();

    expect(screen.getByText(/common questions/i)).toBeInTheDocument();
  });

  it("renders the eyebrow label", () => {
    const { container } = render(<HelpPage />);
    const eyebrow = container.querySelector(".page-hero__eyebrow");
    expect(eyebrow).toBeInTheDocument();
    expect(eyebrow?.textContent).toMatch(/support/i);
  });

  it("renders a navigation landmark with FAQ section links", () => {
    render(<HelpPage />);

    const nav = screen.getByRole("navigation", { name: /faq sections/i });
    expect(nav).toBeInTheDocument();

    const links = within(nav).getAllByRole("link");
    expect(links.length).toBeGreaterThanOrEqual(5);
  });

  it("renders all FAQ section headings", () => {
    render(<HelpPage />);

    const expectedHeadings = [
      "Getting Started",
      "Payment Streams",
      "Account & Security",
      "Troubleshooting",
      "API & Integration",
    ];

    for (const heading of expectedHeadings) {
      expect(
        screen.getByRole("heading", { level: 2, name: heading }),
      ).toBeInTheDocument();
    }
  });

  it("renders key FAQ questions", () => {
    render(<HelpPage />);

    const questions = [
      /what is streampay/i,
      /how do i connect my stellar wallet/i,
      /what are the different stream states/i,
      /does streampay ever see my private key/i,
      /which api version should i use/i,
    ];

    for (const pattern of questions) {
      expect(screen.getByText(pattern)).toBeInTheDocument();
    }
  });

  it("each nav link href points to the correct section id", () => {
    render(<HelpPage />);

    const expected: Array<[string, string]> = [
      ["Getting Started", "#getting-started"],
      ["Payment Streams", "#payment-streams"],
      ["Account & Security", "#account-security"],
      ["Troubleshooting", "#troubleshooting"],
      ["API & Integration", "#api-integration"],
    ];

    for (const [name, href] of expected) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
  });

  it("renders FAQ items as a definition list", () => {
    const { container } = render(<HelpPage />);
    const dls = container.querySelectorAll("dl.faq-list");
    expect(dls.length).toBeGreaterThanOrEqual(5);
  });

  it("every question has a corresponding answer", () => {
    const { container } = render(<HelpPage />);
    const questions = container.querySelectorAll(".faq-item__question");
    const answers = container.querySelectorAll(".faq-item__answer");
    expect(questions.length).toBe(answers.length);
    expect(questions.length).toBeGreaterThan(0);
  });

  it("uses semantic section elements with accessible labels", () => {
    render(<HelpPage />);

    const sections = [
      "Getting Started",
      "Payment Streams",
      "Account & Security",
      "Troubleshooting",
      "API & Integration",
    ];

    for (const label of sections) {
      expect(screen.getByRole("region", { name: label })).toBeInTheDocument();
    }
  });

  it("renders the main landmark", () => {
    render(<HelpPage />);
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("does not render any tabindex overrides", () => {
    const { container } = render(<HelpPage />);
    expect(container.querySelectorAll("[tabindex]")).toHaveLength(0);
  });
});
