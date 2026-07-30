import { withStrongEtag } from './etag';

describe('withStrongEtag', () => {
  it('generates a strong ETag and returns 200 on initial request', () => {
    const data = { hello: 'world' };
    const request = new Request('http://localhost/api', { headers: new Headers() });
    
    const response = withStrongEtag(request, data);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toMatch(/^"[a-f0-9]{64}"$/);
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('returns 304 when If-None-Match matches the ETag', () => {
    const data = { hello: 'world' };
    // Generate the expected ETag beforehand to match it
    const request1 = new Request('http://localhost/api');
    const response1 = withStrongEtag(request1, data);
    const etag = response1.headers.get('etag')!;

    const request2 = new Request('http://localhost/api', {
      headers: new Headers({ 'If-None-Match': etag }),
    });
    
    const response2 = withStrongEtag(request2, data);
    expect(response2.status).toBe(304);
    expect(response2.headers.get('etag')).toBe(etag);
    // Should have no body content
  });

  it('returns 200 when If-None-Match does not match', () => {
    const data = { hello: 'world' };
    const request = new Request('http://localhost/api', {
      headers: new Headers({ 'If-None-Match': '"wrong-hash"' }),
    });
    
    const response = withStrongEtag(request, data);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toMatch(/^"[a-f0-9]{64}"$/);
  });
});
