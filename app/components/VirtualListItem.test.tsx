/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { VirtualListItem } from "./VirtualListItem";

type IntersectionObserverCallback = (
  entries: IntersectionObserverEntry[],
  observer: IntersectionObserver,
) => void;

type ResizeObserverCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver,
) => void;

interface WindowWithObservers {
  IntersectionObserver?: typeof IntersectionObserver;
  ResizeObserver?: typeof ResizeObserver;
}

const targetWindow = window as unknown as WindowWithObservers;

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds: ReadonlyArray<number>;
  callback: IntersectionObserverCallback;
  observedElements = new Set<Element>();

  static instances: MockIntersectionObserver[] = [];

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.callback = callback;
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    this.thresholds = options?.threshold
      ? Array.isArray(options.threshold)
        ? options.threshold
        : [options.threshold]
      : [0];
    MockIntersectionObserver.instances.push(this);
  }

  observe = jest.fn((target: Element) => {
    this.observedElements.add(target);
  });

  unobserve = jest.fn((target: Element) => {
    this.observedElements.delete(target);
  });

  disconnect = jest.fn(() => {
    this.observedElements.clear();
  });

  takeRecords = jest.fn((): IntersectionObserverEntry[] => []);

  trigger(entries: Partial<IntersectionObserverEntry>[]) {
    const fullEntries = entries.map((entry) => ({
      boundingClientRect: entry.boundingClientRect ?? ({} as DOMRectReadOnly),
      intersectionRatio: entry.intersectionRatio ?? (entry.isIntersecting ? 1 : 0),
      intersectionRect: entry.intersectionRect ?? ({} as DOMRectReadOnly),
      isIntersecting: entry.isIntersecting ?? false,
      rootBounds: entry.rootBounds ?? null,
      target: entry.target ?? (this.observedElements.values().next().value as Element),
      time: entry.time ?? Date.now(),
    })) as IntersectionObserverEntry[];

    this.callback(fullEntries, this);
  }
}

class MockResizeObserver implements ResizeObserver {
  callback: ResizeObserverCallback;
  observedElements = new Set<Element>();

  static instances: MockResizeObserver[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe = jest.fn((target: Element) => {
    this.observedElements.add(target);
  });

  unobserve = jest.fn((target: Element) => {
    this.observedElements.delete(target);
  });

  disconnect = jest.fn(() => {
    this.observedElements.clear();
  });

  trigger(
    entries: Array<{
      target?: Element;
      contentRect?: DOMRectReadOnly;
      borderBoxSize?: readonly ResizeObserverSize[];
      contentBoxSize?: readonly ResizeObserverSize[];
      devicePixelContentBoxSize?: readonly ResizeObserverSize[];
    }>,
  ) {
    const fullEntries = entries.map((entry) => ({
      target: entry.target ?? (this.observedElements.values().next().value as Element),
      contentRect: entry.contentRect ?? ({} as DOMRectReadOnly),
      borderBoxSize: entry.borderBoxSize ?? [],
      contentBoxSize: entry.contentBoxSize ?? [],
      devicePixelContentBoxSize: entry.devicePixelContentBoxSize ?? [],
    })) as ResizeObserverEntry[];

    this.callback(fullEntries, this);
  }
}

function getLatestIntersectionObserver(): MockIntersectionObserver {
  const instance =
    MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1];
  if (!instance) {
    throw new Error("No MockIntersectionObserver instance found");
  }
  return instance;
}

function getLatestResizeObserver(): MockResizeObserver {
  const instance =
    MockResizeObserver.instances[MockResizeObserver.instances.length - 1];
  if (!instance) {
    throw new Error("No MockResizeObserver instance found");
  }
  return instance;
}

describe("VirtualListItem", () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    MockResizeObserver.instances = [];
    targetWindow.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;
    targetWindow.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    delete targetWindow.IntersectionObserver;
    delete targetWindow.ResizeObserver;
    jest.restoreAllMocks();
  });

  describe("Observer-less fallback", () => {
    it("renders children and sets no minHeight when both observers are undefined", () => {
      delete targetWindow.IntersectionObserver;
      delete targetWindow.ResizeObserver;

      render(
        <VirtualListItem>
          <span data-testid="child-content">Child item</span>
        </VirtualListItem>,
      );

      const item = screen.getByRole("listitem");
      expect(item).toBeInTheDocument();
      expect(screen.getByTestId("child-content")).toBeInTheDocument();
      expect(item.style.minHeight).toBe("");
    });

    it("renders children and sets no minHeight when only IntersectionObserver is undefined", () => {
      delete targetWindow.IntersectionObserver;

      render(
        <VirtualListItem>
          <span data-testid="child-content">Child item</span>
        </VirtualListItem>,
      );

      const item = screen.getByRole("listitem");
      expect(item).toBeInTheDocument();
      expect(screen.getByTestId("child-content")).toBeInTheDocument();
      expect(item.style.minHeight).toBe("");
      expect(MockResizeObserver.instances).toHaveLength(0);
    });

    it("renders children and sets no minHeight when only ResizeObserver is undefined", () => {
      delete targetWindow.ResizeObserver;

      render(
        <VirtualListItem>
          <span data-testid="child-content">Child item</span>
        </VirtualListItem>,
      );

      const item = screen.getByRole("listitem");
      expect(item).toBeInTheDocument();
      expect(screen.getByTestId("child-content")).toBeInTheDocument();
      expect(item.style.minHeight).toBe("");
      expect(MockIntersectionObserver.instances).toHaveLength(0);
    });
  });

  describe("Intersection observation and offscreen height retention", () => {
    it("configures IntersectionObserver with rootMargin '400px 0px'", () => {
      render(
        <VirtualListItem>
          <span>Visible item</span>
        </VirtualListItem>,
      );

      const observer = getLatestIntersectionObserver();
      expect(observer.rootMargin).toBe("400px 0px");
    });

    it("unmounts children and retains measured height when offscreen, and restores on return", () => {
      jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        height: 180,
        width: 300,
        top: 0,
        left: 0,
        bottom: 180,
        right: 300,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      render(
        <VirtualListItem>
          <span data-testid="content">Item details</span>
        </VirtualListItem>,
      );

      const item = screen.getByRole("listitem");
      expect(screen.getByTestId("content")).toBeInTheDocument();
      expect(item.style.minHeight).toBe("");

      const observer = getLatestIntersectionObserver();

      // Trigger offscreen
      act(() => {
        observer.trigger([{ isIntersecting: false }]);
      });

      expect(screen.queryByTestId("content")).not.toBeInTheDocument();
      expect(item.style.minHeight).toBe("180px");

      // Trigger back onscreen
      act(() => {
        observer.trigger([{ isIntersecting: true }]);
      });

      expect(screen.getByTestId("content")).toBeInTheDocument();
      expect(item.style.minHeight).toBe("");
    });
  });

  describe("ResizeObserver height updates", () => {
    it("updates retained height from borderBoxSize branch", () => {
      render(
        <VirtualListItem>
          <span data-testid="content">Resizable item</span>
        </VirtualListItem>,
      );

      const item = screen.getByRole("listitem");
      const resizeObserver = getLatestResizeObserver();
      const intersectionObserver = getLatestIntersectionObserver();

      act(() => {
        resizeObserver.trigger([
          {
            borderBoxSize: [{ blockSize: 240, inlineSize: 400 }],
          },
        ]);
      });

      // Item goes offscreen, should retain 240px from borderBoxSize
      act(() => {
        intersectionObserver.trigger([{ isIntersecting: false }]);
      });

      expect(screen.queryByTestId("content")).not.toBeInTheDocument();
      expect(item.style.minHeight).toBe("240px");
    });

    it("updates retained height from contentRect branch", () => {
      render(
        <VirtualListItem>
          <span data-testid="content">Resizable item</span>
        </VirtualListItem>,
      );

      const item = screen.getByRole("listitem");
      const resizeObserver = getLatestResizeObserver();
      const intersectionObserver = getLatestIntersectionObserver();

      act(() => {
        resizeObserver.trigger([
          {
            borderBoxSize: [],
            contentRect: { height: 195, width: 300 } as DOMRectReadOnly,
          },
        ]);
      });

      // Item goes offscreen, should retain 195px from contentRect
      act(() => {
        intersectionObserver.trigger([{ isIntersecting: false }]);
      });

      expect(screen.queryByTestId("content")).not.toBeInTheDocument();
      expect(item.style.minHeight).toBe("195px");
    });
  });

  describe("Ref forwarding, no-ref handling, and props merging", () => {
    it("forwards object ref to the <li> element", () => {
      const ref = React.createRef<HTMLLIElement>();

      render(
        <VirtualListItem ref={ref}>
          <span>With object ref</span>
        </VirtualListItem>,
      );

      expect(ref.current).toBeInstanceOf(HTMLLIElement);
      expect(ref.current?.tagName).toBe("LI");
    });

    it("forwards callback ref to the <li> element", () => {
      const refCallback = jest.fn();

      render(
        <VirtualListItem ref={refCallback}>
          <span>With callback ref</span>
        </VirtualListItem>,
      );

      expect(refCallback).toHaveBeenCalledWith(expect.any(HTMLLIElement));
      const calledElement = refCallback.mock.calls[0][0] as HTMLLIElement;
      expect(calledElement.tagName).toBe("LI");
    });

    it("attaches observers when no ref is forwarded", () => {
      render(
        <VirtualListItem>
          <span>Without forwarded ref</span>
        </VirtualListItem>,
      );

      const item = screen.getByRole("listitem");
      const intersectionObserver = getLatestIntersectionObserver();
      const resizeObserver = getLatestResizeObserver();

      expect(intersectionObserver.observe).toHaveBeenCalledWith(item);
      expect(resizeObserver.observe).toHaveBeenCalledWith(item);
    });

    it("merges extra props including className, data attributes, and custom style", () => {
      render(
        <VirtualListItem
          className="custom-list-item"
          data-testid="merged-props-item"
          data-index={42}
          style={{ opacity: 0.9, backgroundColor: "rgb(255, 0, 0)" }}
        >
          <span>Child</span>
        </VirtualListItem>,
      );

      const item = screen.getByTestId("merged-props-item");
      expect(item).toHaveClass("custom-list-item");
      expect(item).toHaveAttribute("data-index", "42");
      expect(item.style.opacity).toBe("0.9");
      expect(item.style.backgroundColor).toBe("rgb(255, 0, 0)");
      expect(item.style.minHeight).toBe("");
    });
  });

  describe("Cleanup on unmount", () => {
    it("disconnects both observers on unmount", () => {
      const { unmount } = render(
        <VirtualListItem>
          <span>Unmounting item</span>
        </VirtualListItem>,
      );

      const intersectionObserver = getLatestIntersectionObserver();
      const resizeObserver = getLatestResizeObserver();

      expect(intersectionObserver.disconnect).not.toHaveBeenCalled();
      expect(resizeObserver.disconnect).not.toHaveBeenCalled();

      unmount();

      expect(intersectionObserver.disconnect).toHaveBeenCalledTimes(1);
      expect(resizeObserver.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe("Edge cases", () => {
    it("uses defaultHeight when measured height is 0", () => {
      jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        height: 0,
        width: 0,
        top: 0,
        left: 0,
        bottom: 0,
        right: 0,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      render(
        <VirtualListItem defaultHeight={125}>
          <span data-testid="zero-height-item">Zero height content</span>
        </VirtualListItem>,
      );

      const item = screen.getByRole("listitem");
      const observer = getLatestIntersectionObserver();

      act(() => {
        observer.trigger([{ isIntersecting: false }]);
      });

      expect(screen.queryByTestId("zero-height-item")).not.toBeInTheDocument();
      expect(item.style.minHeight).toBe("125px");
    });

    it("falls back to defaultHeight = 100 when measured height is 0 and no defaultHeight prop is provided", () => {
      jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        height: 0,
        width: 0,
        top: 0,
        left: 0,
        bottom: 0,
        right: 0,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      render(
        <VirtualListItem>
          <span data-testid="default-100-item">Default 100 content</span>
        </VirtualListItem>,
      );

      const item = screen.getByRole("listitem");
      const observer = getLatestIntersectionObserver();

      act(() => {
        observer.trigger([{ isIntersecting: false }]);
      });

      expect(screen.queryByTestId("default-100-item")).not.toBeInTheDocument();
      expect(item.style.minHeight).toBe("100px");
    });

    it("handles rapid visible/hidden toggling cleanly", () => {
      jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        height: 160,
        width: 320,
        top: 0,
        left: 0,
        bottom: 160,
        right: 320,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      render(
        <VirtualListItem>
          <span data-testid="rapid-toggle-child">Toggling content</span>
        </VirtualListItem>,
      );

      const item = screen.getByRole("listitem");
      const observer = getLatestIntersectionObserver();

      for (let i = 0; i < 4; i++) {
        act(() => {
          observer.trigger([{ isIntersecting: false }]);
        });
        expect(screen.queryByTestId("rapid-toggle-child")).not.toBeInTheDocument();
        expect(item.style.minHeight).toBe("160px");

        act(() => {
          observer.trigger([{ isIntersecting: true }]);
        });
        expect(screen.getByTestId("rapid-toggle-child")).toBeInTheDocument();
        expect(item.style.minHeight).toBe("");
      }
    });
  });
});
