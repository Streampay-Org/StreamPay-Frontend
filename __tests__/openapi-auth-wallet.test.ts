/**
 * OpenAPI examples coverage for GET/POST /api/auth/wallet (issue #1105).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

function loadOpenApiSpec(): any {
  const raw = readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8');
  return JSON.parse(raw);
}

describe('OpenAPI examples /api/auth/wallet', () => {
  const spec = loadOpenApiSpec();
  const wallet = spec.paths['/api/auth/wallet'];

  it('declares /api/auth/wallet path with GET and POST', () => {
    expect(wallet).toBeDefined();
    expect(wallet.get).toBeDefined();
    expect(wallet.post).toBeDefined();
  });

  it('GET 200 includes walletChallenge example', () => {
    const examples =
      wallet.get.responses['200'].content['application/json'].examples;
    expect(examples.walletChallenge).toBeDefined();
    expect(examples.walletChallenge.value).toEqual(
      expect.objectContaining({
        challenge: expect.any(String),
        expires_at: expect.any(String),
      }),
    );
  });

  it('GET 200 walletChallenge example validates against the response schema', () => {
    const content = wallet.get.responses['200'].content['application/json'];
    const schemaRef: string = content.schema.$ref;
    const schemaName = schemaRef.replace('#/components/schemas/', '');
    const schema = spec.components.schemas[schemaName];
    const exampleValue = content.examples.walletChallenge.value;

    expect(schema).toBeDefined();
    for (const requiredKey of schema.required ?? []) {
      expect(exampleValue[requiredKey]).toBeDefined();
    }
    for (const [propName, propSchema] of Object.entries<any>(schema.properties ?? {})) {
      if (exampleValue[propName] !== undefined) {
        expect(typeof exampleValue[propName]).toBe(propSchema.type);
      }
    }
  });

  it('GET error responses include example envelopes with request_id', () => {
    for (const code of ['400', '422', '429'] as const) {
      const examples =
        wallet.get.responses[code].content['application/json'].examples;
      const first = Object.values(examples)[0] as { value: any };
      expect(first.value.error).toEqual(
        expect.objectContaining({
          code: expect.any(String),
          message: expect.any(String),
          request_id: expect.any(String),
        }),
      );
    }
  });

  it('POST 200 includes walletToken example', () => {
    const examples =
      wallet.post.responses['200'].content['application/json'].examples;
    expect(examples.walletToken.value).toEqual(
      expect.objectContaining({
        token: expect.any(String),
        expires_at: expect.any(String),
      }),
    );
  });

  it('POST requestBody includes verifySignature example', () => {
    const examples =
      wallet.post.requestBody.content['application/json'].examples;
    expect(examples.verifySignature.value).toEqual(
      expect.objectContaining({
        address: expect.any(String),
        challenge: expect.any(String),
        signature: expect.any(String),
      }),
    );
  });

  it('POST error responses include standardized error envelopes', () => {
    for (const code of ['400', '401', '422', '429'] as const) {
      const examples =
        wallet.post.responses[code].content['application/json'].examples;
      const first = Object.values(examples)[0] as { value: any };
      expect(first.value.error.request_id).toMatch(/^req_/);
    }
  });
});
