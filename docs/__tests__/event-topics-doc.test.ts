/**
 * @jest-environment node
 *
 * Keeps `docs/EVENT_TOPICS.md` in sync with the Soroban contract event topics.
 *
 * The event catalogue is prose, so nothing else in CI notices when a Rust
 * `#[contractevent(topics = [...])]` attribute is added without a matching doc
 * row (or vice versa). This test reads the contract sources, extracts every
 * topic pair, and compares it with the Markdown tables.
 *
 * Some admin events are emitted with `symbol_short!` rather than
 * `#[contractevent]`. Those are listed explicitly in
 * `SYMBOL_SHORT_ALLOWLIST` so a documented pair is accepted, and a second test
 * keeps that allowlist aligned with `events.rs`.
 */

import { readFileSync } from "fs";
import { join } from "path";

type TopicPair = [string, string];

const CONTRACT_SRC = join(
  __dirname,
  "..",
  "..",
  "contracts",
  "contracts",
  "streampay-stream",
  "src",
);
const DOC_PATH = join(__dirname, "..", "EVENT_TOPICS.md");

const CONTRACT_SOURCES = ["events.rs", "multi.rs", "recurring.rs"] as const;

/** Topics emitted with `symbol_short!` in events.rs instead of `#[contractevent]`. */
const SYMBOL_SHORT_ALLOWLIST: TopicPair[] = [
  ["stream", "set_pause"],
  ["stream", "set_admin"],
  ["stream", "set_token"],
  ["stream", "set_fee_c"],
  ["stream", "set_dfee"],
  ["stream", "fee"],
  ["stream", "cooloff"],
  ["stream", "swept"],
];

function pairKey(pair: TopicPair): string {
  return `${pair[0]}|${pair[1]}`;
}

/**
 * Removes Rust line and block comments without touching string literals, so
 * commented-out examples cannot satisfy the documentation check.
 */
export function stripRustComments(source: string): string {
  let result = "";
  let index = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      index += 1;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (char === "\\") {
        result += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 2;
      continue;
    }
    if (char === '"') {
      inString = true;
    }

    result += char;
    index += 1;
  }

  return result;
}

/** Extracts every `#[contractevent(topics = ["a", "b"], ...)]` pair. */
export function extractContractEventTopics(source: string): TopicPair[] {
  const clean = stripRustComments(source);
  const pairs: TopicPair[] = [];
  const attribute = /#\s*\[\s*contractevent\s*\(([\s\S]*?)\)\s*\]/g;

  let match: RegExpExecArray | null;
  while ((match = attribute.exec(clean)) !== null) {
    const topics = match[1].match(
      /topics\s*=\s*\[\s*"([^"]+)"\s*,\s*"([^"]+)"(?:\s*,[^\]]*)?\s*\]/,
    );
    if (topics) {
      pairs.push([topics[1], topics[2]]);
    }
  }

  return pairs;
}

/** Extracts `(symbol_short!("a"), symbol_short!("b"))` pairs. */
export function extractSymbolShortTopics(source: string): TopicPair[] {
  const clean = stripRustComments(source);
  const pairs: TopicPair[] = [];
  const pattern =
    /\(\s*symbol_short!\("([^"]+)"\)\s*,\s*symbol_short!\("([^"]+)"\)\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean)) !== null) {
    pairs.push([match[1], match[2]]);
  }

  return pairs;
}

/** Parses the first two quoted values from every Markdown table row. */
export function parseDocumentedTopics(doc: string): TopicPair[] {
  const pairs: TopicPair[] = [];

  for (const line of doc.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;

    const quoted = Array.from(trimmed.matchAll(/"([^"]+)"/g)).map((m) => m[1]);
    if (quoted.length >= 2) {
      pairs.push([quoted[0], quoted[1]]);
    }
  }

  return pairs;
}

export function findUndocumentedTopics(
  contractPairs: TopicPair[],
  documentedPairs: TopicPair[],
): TopicPair[] {
  const documented = new Set(documentedPairs.map(pairKey));
  return contractPairs.filter((pair) => !documented.has(pairKey(pair)));
}

export function findUnexpectedDocumentedTopics(
  documentedPairs: TopicPair[],
  contractPairs: TopicPair[],
  allowlist: TopicPair[],
): TopicPair[] {
  const known = new Set(
    [...contractPairs, ...allowlist].map(pairKey),
  );
  return documentedPairs.filter((pair) => !known.has(pairKey(pair)));
}

function readContractSource(file: string): string {
  return readFileSync(join(CONTRACT_SRC, file), "utf8");
}

const contractPairs = CONTRACT_SOURCES.flatMap((file) =>
  extractContractEventTopics(readContractSource(file)),
);
const symbolShortPairs = extractSymbolShortTopics(readContractSource("events.rs"));
const doc = readFileSync(DOC_PATH, "utf8");
const documentedPairs = parseDocumentedTopics(doc);

describe("contract event extraction", () => {
  it("finds contractevent topics in all three contract modules", () => {
    const keys = contractPairs.map(pairKey);
    expect(keys).toContain(pairKey(["stream", "created"]));
    expect(keys).toContain(pairKey(["StreamPay", "upgraded"]));
    expect(keys).toContain(pairKey(["stream", "split_cr"]));
    expect(keys).toContain(pairKey(["recurring", "created"]));
    expect(contractPairs.length).toBeGreaterThanOrEqual(18);
  });

  it("ignores commented-out contractevent examples", () => {
    const source = `
      // #[contractevent(topics = ["fake", "line_comment"])]
      /* #[contractevent(topics = ["fake", "block_comment"])] */
      #[contractevent(topics = ["stream", "created"], data_format = "vec")]
      pub struct Created;
    `;
    expect(extractContractEventTopics(source)).toEqual([["stream", "created"]]);
  });

  it("handles multi-line contractevent attributes", () => {
    const source = `
      #[contractevent(
        topics = [
          "stream",
          "created"
        ],
        data_format = "vec"
      )]
      pub struct Created;
    `;
    expect(extractContractEventTopics(source)).toEqual([["stream", "created"]]);
  });
});

describe("docs/EVENT_TOPICS.md", () => {
  it("documents every contractevent topic", () => {
    expect(findUndocumentedTopics(contractPairs, documentedPairs)).toEqual([]);
  });

  it("only documents real contractevent or symbol_short topics", () => {
    expect(
      findUnexpectedDocumentedTopics(
        documentedPairs,
        contractPairs,
        SYMBOL_SHORT_ALLOWLIST,
      ),
    ).toEqual([]);
  });

  it("documents every symbol_short topic in the allowlist", () => {
    const documented = new Set(documentedPairs.map(pairKey));
    for (const pair of SYMBOL_SHORT_ALLOWLIST) {
      expect(documented.has(pairKey(pair))).toBe(true);
    }
  });

  it("keeps the symbol_short allowlist in sync with events.rs", () => {
    const actual = symbolShortPairs.map(pairKey).sort();
    const allowed = SYMBOL_SHORT_ALLOWLIST.map(pairKey).sort();
    expect(actual).toEqual(allowed);
  });

  it("fails the check when a doc row is removed", () => {
    const removed = documentedPairs[0];
    const withoutRemovedRow = documentedPairs.filter(
      (pair) => pairKey(pair) !== pairKey(removed),
    );

    expect(
      findUndocumentedTopics(contractPairs, withoutRemovedRow),
    ).toContainEqual(removed);
  });

  it("parses table rows that have extra columns", () => {
    const synthetic = `
| Primary Topic | Sub-topic | Description | Notes |
| --- | --- | --- | --- |
| \`"stream"\` | \`"created"\` | Created. | extra |
    `;
    expect(parseDocumentedTopics(synthetic)).toEqual([["stream", "created"]]);
  });
});
