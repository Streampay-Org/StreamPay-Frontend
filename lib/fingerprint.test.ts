/**
 * @jest-environment node
 */
import { generateFingerprint } from './fingerprint';

describe('generateFingerprint', () => {
  it('generates the same fingerprint for identical requests', () => {
    const req = new Request('https://api.example.com/api/v2/streams', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '1.1.1.1',
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
      },
    });
    const fp1 = generateFingerprint(req);
    const fp2 = generateFingerprint(req);
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(64); // SHA-256 hex length
  });

  it('normalizes method to uppercase', () => {
    const req1 = new Request('https://api.example.com/api/v2/streams', { method: 'get' });
    const req2 = new Request('https://api.example.com/api/v2/streams', { method: 'GET' });
    expect(generateFingerprint(req1)).toBe(generateFingerprint(req2));
  });

  it('normalizes path by removing trailing slashes', () => {
    const req1 = new Request('https://api.example.com/api/v2/streams/', { method: 'GET' });
    const req2 = new Request('https://api.example.com/api/v2/streams', { method: 'GET' });
    expect(generateFingerprint(req1)).toBe(generateFingerprint(req2));
  });

  it('normalizes IP from forwarded headers', () => {
    const req1 = new Request('https://api.example.com/api/v2/streams', {
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
    });
    const req2 = new Request('https://api.example.com/api/v2/streams', {
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    expect(generateFingerprint(req1)).toBe(generateFingerprint(req2));
  });

  it('normalizes Accept-Language', () => {
    const req1 = new Request('https://api.example.com/api/v2/streams', {
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    const req2 = new Request('https://api.example.com/api/v2/streams', {
      headers: { 'accept-language': 'en-us' },
    });
    // This expects just the primary tag "en-us"
    // Wait, the implementation does .split(',')[0].trim().toLowerCase()
    // en-US,en;q=0.9 -> split(',')[0] -> en-US -> lowercased -> en-us
    expect(generateFingerprint(req1)).toBe(generateFingerprint(req2));
  });

  it('normalizes Accept-Encoding (sorted)', () => {
    const req1 = new Request('https://api.example.com/api/v2/streams', {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });
    const req2 = new Request('https://api.example.com/api/v2/streams', {
      headers: { 'accept-encoding': 'br, gzip, deflate' },
    });
    expect(generateFingerprint(req1)).toBe(generateFingerprint(req2));
  });

  it('returns a fallback fingerprint on error', () => {
    // Mock a request with an invalid URL that triggers the catch block
    const req = { url: ':', method: 'GET', headers: new Headers() } as unknown as Request;
    const fp = generateFingerprint(req);
    expect(fp).toBe('fingerprint-error');
  });
});
