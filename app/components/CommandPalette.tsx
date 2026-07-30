"use client";

import React, {
  KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type { StreamRowData } from "./StreamRow";

interface CommandPaletteProps {
  streams: StreamRowData[];
}

function highlightMatch(text: string, query: string) {
  if (!query) return text;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part) ? (
      <span key={i} style={{ color: "var(--accent)", fontWeight: 700 }}>
        {part}
      </span>
    ) : (
      part
    )
  );
}

export function CommandPalette({ streams }: CommandPaletteProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const titleId = useId();

  const filtered = query
    ? streams.filter(
        (s) =>
          s.recipient.toLowerCase().includes(query.toLowerCase()) ||
          s.id.toLowerCase().includes(query.toLowerCase()) ||
          s.rate.toLowerCase().includes(query.toLowerCase()) ||
          s.schedule.toLowerCase().includes(query.toLowerCase())
      )
    : streams;

  const open = useCallback(() => {
    setIsOpen(true);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        if (isOpen) {
          close();
        } else {
          open();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, open, close]);

  useEffect(() => {
    if (isOpen) {
      setSelectedIndex(0);
      const timer = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filtered.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      return;
    }

    if (event.key === "Enter" && filtered[selectedIndex]) {
      event.preventDefault();
      const selected = filtered[selectedIndex];
      router.push(`/streams/${selected.id}`);
      close();
      return;
    }
  };

  useEffect(() => {
    const selectedEl = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
        zIndex: 1000,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          width: "100%",
          maxWidth: "560px",
          backgroundColor: "var(--panel-elevated)",
          border: "1px solid var(--border)",
          borderRadius: "1rem",
          boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "0.75rem" }}>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={filtered[selectedIndex] ? `cp-option-${selectedIndex}` : undefined}
            aria-labelledby={titleId}
            placeholder="Search streams by recipient, ID, rate, or schedule..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            style={{
              width: "100%",
              padding: "0.75rem 1rem",
              backgroundColor: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: "0.75rem",
              color: "var(--foreground)",
              fontSize: "1rem",
              outline: "none",
              boxSizing: "border-box",
            }}
            onFocus={(e) => {
              e.target.style.borderColor = "var(--accent)";
              e.target.style.boxShadow = "0 0 0 2px rgba(34, 197, 94, 0.15)";
            }}
            onBlur={(e) => {
              e.target.style.borderColor = "var(--border)";
              e.target.style.boxShadow = "none";
            }}
          />
        </div>

        <h2 id={titleId} style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" }}>
          Stream search
        </h2>

        {filtered.length === 0 ? (
          <p
            style={{
              padding: "2rem 1rem",
              textAlign: "center",
              color: "var(--muted)",
              fontSize: "0.875rem",
            }}
          >
            No streams match &ldquo;{query}&rdquo;
          </p>
        ) : (
          <ul
            ref={listRef}
            id="command-palette-list"
            role="listbox"
            aria-label="Search results"
            style={{
              listStyle: "none",
              margin: 0,
              padding: "0 0.5rem 0.5rem",
              maxHeight: "min(60vh, 360px)",
              overflowY: "auto",
            }}
          >
            {filtered.map((stream, index) => (
              <li
                key={stream.id}
                id={`cp-option-${index}`}
                role="option"
                aria-selected={index === selectedIndex}
                onMouseDown={() => {
                  router.push(`/streams/${stream.id}`);
                  close();
                }}
                onMouseEnter={() => setSelectedIndex(index)}
                style={{
                  padding: "0.75rem",
                  borderRadius: "0.75rem",
                  cursor: "pointer",
                  backgroundColor:
                    index === selectedIndex ? "var(--accent)" : "transparent",
                  color:
                    index === selectedIndex
                      ? "var(--accent-on)"
                      : "var(--foreground)",
                  transition: "background-color 100ms ease",
                  marginBottom: "0.25rem",
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: "0.125rem" }}>
                  {highlightMatch(stream.recipient, query)}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    fontSize: "0.8125rem",
                    color:
                      index === selectedIndex
                        ? "var(--accent-on)"
                        : "var(--muted-light)",
                    opacity: index === selectedIndex ? 0.9 : 1,
                  }}
                >
                  <span>{highlightMatch(stream.rate, query)}</span>
                  <span>{highlightMatch(stream.schedule, query)}</span>
                  <span
                    style={{
                      marginLeft: "auto",
                      textTransform: "capitalize",
                    }}
                  >
                    {stream.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div
          style={{
            display: "flex",
            gap: "1rem",
            justifyContent: "center",
            padding: "0.5rem 0.75rem 0.75rem",
            borderTop: "1px solid var(--border)",
            fontSize: "0.75rem",
            color: "var(--muted)",
          }}
        >
          <span>
            <kbd style={kbdStyle}>&uarr;</kbd> <kbd style={kbdStyle}>&darr;</kbd> navigate
          </span>
          <span>
            <kbd style={kbdStyle}>&crarr;</kbd> select
          </span>
          <span>
            <kbd style={kbdStyle}>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

const kbdStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "0.125rem 0.375rem",
  fontSize: "0.6875rem",
  fontWeight: 700,
  lineHeight: 1,
  color: "var(--muted-light)",
  backgroundColor: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: "0.25rem",
  minWidth: "1.25rem",
  textAlign: "center",
};
