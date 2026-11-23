/**
 * OpenAPI specification coverage for all webhook routes under app/api/webhooks.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const OPENAPI_SPEC_PATH = path.resolve(__dirname, '..', 'openapi.json');
const WEBHOOKS_APP_DIR = path.resolve(REPO_ROOT, 'app', 'api', 'webhooks');

interface OpenApiSpec {
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    responses?: Record<string, OpenApiResponse>;
    schemas?: Record<string, unknown>;
  };
}

interface OpenApiOperation {
  operationId?: string;
  responses?: Record<string, OpenApiResponse>;
}

interface OpenApiResponse {
  $ref?: string;
  description?: string;
  content?: Record<
    string,
    {
      schema?: { $ref?: string };
    }
  >;
}

interface DiscoveredOperation {
  routeFile: string;
  specPath: string;
  method: string;
}

function loadOpenApiSpec(): OpenApiSpec {
  return JSON.parse(readFileSync(OPENAPI_SPEC_PATH, 'utf8')) as OpenApiSpec;
}

function findWebhookRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findWebhookRouteFiles(fullPath));
    } else if (entry.name === 'route.ts') {
      results.push(fullPath);
    }
  }
  return results.sort();
}

function routeFileToSpecPath(routeFile: string): string {
  const relDir = path.relative(WEBHOOKS_APP_DIR, path.dirname(routeFile));
  if (!relDir) {
    return '/api/webhooks';
  }
  const segments = relDir
    .split(path.sep)
    .map((seg) => seg.replace(/^\[(.+)\]$/, '{$1}'));
  return `/api/webhooks/${segments.join('/')}`;
}

function extractExportedMethods(routeFile: string): string[] {
  const source = readFileSync(routeFile, 'utf8');
  const methods: string[] = [];
  const regex = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    methods.push(match[1].toLowerCase());
  }
  return methods;
}

function discoverWebhookOperations(): DiscoveredOperation[] {
  const routeFiles = findWebhookRouteFiles(WEBHOOKS_APP_DIR);
  const operations: DiscoveredOperation[] = [];

  for (const routeFile of routeFiles) {
    const specPath = routeFileToSpecPath(routeFile);
    const methods = extractExportedMethods(routeFile);
    for (const method of methods) {
      operations.push({
        routeFile: path.relative(REPO_ROOT, routeFile),
        specPath,
        method,
      });
    }
  }

  return operations;
}

function resolveResponse(
  spec: OpenApiSpec,
  response: OpenApiResponse | undefined,
): OpenApiResponse | undefined {
  if (!response) return undefined;
  if (response.$ref?.startsWith('#/components/responses/')) {
    const key = response.$ref.slice('#/components/responses/'.length);
    return spec.components?.responses?.[key];
  }
  return response;
}

/**
 * Expected status codes returned by each webhook handler.
 */
const EXPECTED_STATUS_CODES: Record<string, string[]> = {
  'GET /api/webhooks': ['200', '429', '500'],
  'POST /api/webhooks': ['200', '400', '413', '429', '500'],
  'GET /api/webhooks/deliveries': ['200', '400', '422', '500'],
  'POST /api/webhooks/dlq': ['200', '400', '500'],
  'POST /api/webhooks/dlq/{dlqId}/replay': ['200', '401', '404', '502'],
  'GET /api/webhooks/health': ['200', '500'],
  'POST /api/webhooks/rotate': ['200', '400', '403', '422'],
};

const discoveredOperations = discoverWebhookOperations();

describe('OpenAPI coverage for /api/webhooks routes', () => {
  const spec = loadOpenApiSpec();

  it('discovers a non-empty set of webhook route operations', () => {
    expect(discoveredOperations.length).toBeGreaterThanOrEqual(7);
  });

  it('defines the shared ErrorEnvelope schema', () => {
    expect(spec.components?.schemas?.ErrorEnvelope).toBeDefined();
  });

  it.each(discoveredOperations)(
    '$method $specPath ($routeFile) is documented with expected responses and ErrorEnvelope on errors',
    ({ specPath, method }) => {
      const pathItem = spec.paths?.[specPath];
      expect(pathItem).toBeDefined();

      const operation = pathItem?.[method];
      expect(operation).toBeDefined();
      expect(operation?.responses).toBeDefined();

      const key = `${method.toUpperCase()} ${specPath}`;
      const expectedCodes = EXPECTED_STATUS_CODES[key];
      expect(expectedCodes).toBeDefined();

      for (const code of expectedCodes) {
        const rawResponse = operation?.responses?.[code];
        expect(rawResponse).toBeDefined();

        const statusNum = Number(code);
        if (statusNum >= 400) {
          const resolved = resolveResponse(spec, rawResponse);
          expect(resolved).toBeDefined();
          expect(
            resolved?.content?.['application/json']?.schema?.$ref,
          ).toBe('#/components/schemas/ErrorEnvelope');
        }
      }
    },
  );
});
