/**
 * @jest-environment node
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const requireFromHere = createRequire(__filename);
const tscBin = requireFromHere.resolve("typescript/bin/tsc");

const repoRoot = resolve(__dirname, "../..");
const sdkDir = resolve(repoRoot, "lib/sdk");

function runTsc(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [tscBin, ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
}

const TYPESCRIPT_CONFIG = {
  compilerOptions: {
    target: "ES2020",
    lib: ["ES2020", "DOM"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  },
};

describe("@streampay/sdk package", () => {
  let workspace: string;
  let packageDir: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "streampay-sdk-smoke-"));
    packageDir = join(workspace, "node_modules", "@streampay", "sdk");
    mkdirSync(packageDir, { recursive: true });

    runTsc(
      ["-p", join(sdkDir, "tsconfig.build.json"), "--outDir", join(packageDir, "dist")],
      repoRoot
    );
    cpSync(join(sdkDir, "package.json"), join(packageDir, "package.json"));
  }, 180_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { force: true, recursive: true });
  });

  it("emits the entry points declared by the exports map", () => {
    for (const file of [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/types.js",
      "dist/types.d.ts",
    ]) {
      expect(existsSync(join(packageDir, file))).toBe(true);
    }

    const pkg = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8")
    ) as {
      exports: Record<string, { types: string; import: string }>;
      files: string[];
      sideEffects: boolean;
      type: string;
      version: string;
    };

    expect(pkg.type).toBe("module");
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.files).toEqual(["dist"]);
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.exports["."].import).toBe("./dist/index.js");
    expect(pkg.exports["."].types).toBe("./dist/index.d.ts");
    expect(pkg.exports["./types"].import).toBe("./dist/types.js");
    expect(pkg.exports["./types"].types).toBe("./dist/types.d.ts");
  });

  it("resolves and runs through the package exports map", () => {
    const consumerPath = join(workspace, "consumer.mjs");
    writeFileSync(
      consumerPath,
      `import assert from "node:assert/strict";
import { createStreamPayClient, SdkErrorCode } from "@streampay/sdk";
import { SdkErrorCode as TypesSdkErrorCode } from "@streampay/sdk/types";

const requests = [];
const fetchFn = async (url, init) => {
  requests.push({ url: String(url), init });
  return new Response(
    JSON.stringify({
      data: { id: "stream-1", recipient: "GABC", rate: "10", status: "active" },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

const client = createStreamPayClient({
  baseUrl: "https://api.example.test",
  fetchFn,
  requestIdFactory: () => "req-smoke",
});

const stream = await client.getStream("stream-1");
assert.equal(stream.id, "stream-1");
assert.equal(
  requests[0].url,
  "https://api.example.test/api/v2/streams/stream-1"
);
assert.equal(requests[0].init.headers.get("x-request-id"), "req-smoke");
assert.equal(SdkErrorCode.HTTP_ERROR, "HTTP_ERROR");
assert.equal(TypesSdkErrorCode.HTTP_ERROR, "HTTP_ERROR");

console.log("OK");
`,
      "utf8"
    );

    const output = execFileSync(process.execPath, [consumerPath], {
      cwd: workspace,
      encoding: "utf8",
      stdio: "pipe",
    });

    expect(output.trim()).toBe("OK");
  }, 60_000);

  it("resolves the generated type declarations for a consumer", () => {
    writeFileSync(
      join(workspace, "consumer.mts"),
      `import {
  createStreamPayClient,
  type StreamPayActivityEvent,
  type StreamPayClient,
  type StreamPayClientOptions,
  type StreamPayPage,
  type StreamPayStream,
  type StreamPayStreamList,
} from "@streampay/sdk";
import { SdkErrorCode } from "@streampay/sdk/types";

const options: StreamPayClientOptions = {
  baseUrl: "https://api.example.test",
  token: "test-token",
  requestIdFactory: () => "req-fixture",
};
const client: StreamPayClient = createStreamPayClient(options);
const stream: Promise<StreamPayStream> = client.getStream("stream-1");
const streams: Promise<StreamPayStreamList> = client.listStreams({
  status: "active",
  limit: 5,
});
const activity: Promise<StreamPayPage<StreamPayActivityEvent>> =
  client.listActivity();
const code: SdkErrorCode = SdkErrorCode.HTTP_ERROR;

void stream;
void streams;
void activity;
void code;
`,
      "utf8"
    );
    writeFileSync(
      join(workspace, "tsconfig.consumer.json"),
      JSON.stringify({ ...TYPESCRIPT_CONFIG, include: ["consumer.mts"] }),
      "utf8"
    );

    expect(() =>
      runTsc(["-p", join(workspace, "tsconfig.consumer.json")], workspace)
    ).not.toThrow();
  }, 60_000);

  it("fails type-checking when a declared export is missing", () => {
    writeFileSync(
      join(workspace, "bad-consumer.mts"),
      `import { notARealExport } from "@streampay/sdk";

void notARealExport;
`,
      "utf8"
    );
    writeFileSync(
      join(workspace, "tsconfig.bad.json"),
      JSON.stringify({ ...TYPESCRIPT_CONFIG, include: ["bad-consumer.mts"] }),
      "utf8"
    );

    expect(() =>
      runTsc(["-p", join(workspace, "tsconfig.bad.json")], workspace)
    ).toThrow();
  }, 60_000);
});
