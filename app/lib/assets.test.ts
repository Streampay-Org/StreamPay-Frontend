import * as fc from 'fast-check';
import { parseAssetString, verifyTrustline, validateAssetPair, NATIVE_ASSET } from './assets';
import { isValidStellarPublicKey } from './wallet-link';

// A checksum-valid Stellar public key for testing
const VALID_ISSUER = 'GBWFVUE66GCA5UY7KGG5T37JNCASPSRLQDVEXMCF6IWJJCDUJE25QKJ7';

describe('Asset Engine', () => {
  describe('parseAssetString', () => {
    it('parses XLM correctly', () => {
      expect(parseAssetString('XLM')).toEqual(NATIVE_ASSET);
      expect(parseAssetString('native')).toEqual(NATIVE_ASSET);
    });

    it('parses custom assets correctly with valid issuer', () => {
      const assetStr = `USDC:${VALID_ISSUER}`;
      const parsed = parseAssetString(assetStr);
      expect(parsed.code).toBe('USDC');
      expect(parsed.issuer).toBe(VALID_ISSUER);
      expect(parsed.isNative).toBe(false);
    });

    it('rejects issuer with bad checksum', () => {
      // 56 chars, starts with G, valid base32 but fails CRC16 checksum
      const badIssuer = 'G5555555555555555555555555555555555555555555555555555555';
      expect(badIssuer.length).toBe(56);
      expect(badIssuer.startsWith('G')).toBe(true);
      expect(isValidStellarPublicKey(badIssuer)).toBe(false);
      expect(() => parseAssetString(`USDC:${badIssuer}`)).toThrow('Invalid asset format');
    });

    it('throws on invalid formats', () => {
      expect(() => parseAssetString('USDC')).toThrow();
      expect(() => parseAssetString('USDC:short')).toThrow();
    });

    it('rejects issuer that is not a valid Stellar key', () => {
      const nonKeyIssuer = 'G' + 'A'.repeat(55);
      expect(isValidStellarPublicKey(nonKeyIssuer)).toBe(false);
      expect(() => parseAssetString(`USDC:${nonKeyIssuer}`)).toThrow('Invalid asset format');
    });

    it('rejects issuer failing StrKey checksum (property-based)', () => {
      const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const base32Char = fc.constantFrom(...base32Alphabet.split(''));

      fc.assert(
        fc.property(
          fc.array(base32Char, { minLength: 55, maxLength: 55 }).map(chars => 'G' + chars.join('')),
          (issuer) => {
            fc.pre(!isValidStellarPublicKey(issuer));
            expect(() => parseAssetString('CODE:' + issuer)).toThrow('Invalid asset format');
          }
        ),
        { numRuns: 200, seed: 42 }
      );
    });
  });

  describe('verifyTrustline', () => {
    const mockPublicKey = 'GBZZ..';
    const customAsset = { 
      code: 'USDC', 
      issuer: 'GA5Z..', 
      isNative: false 
    };

    beforeEach(() => {
      global.fetch = jest.fn();
    });

    it('returns true for native asset without network call', async () => {
      const result = await verifyTrustline(mockPublicKey, NATIVE_ASSET);
      expect(result.exists).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('returns true if trustline exists', async () => {
      (fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          balances: [
            { asset_code: 'USDC', asset_issuer: 'GA5Z..' }
          ]
        })
      });

      const result = await verifyTrustline(mockPublicKey, customAsset);
      expect(result.exists).toBe(true);
    });

    it('returns false and error if trustline missing', async () => {
       (fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          balances: [
            { asset_type: 'native' }
          ]
        })
      });

      const result = await verifyTrustline(mockPublicKey, customAsset);
      expect(result.exists).toBe(false);
      expect(result.error).toContain('Missing trustline');
    });

    it('handles 404 account not found', async () => {
      (fetch as jest.Mock).mockResolvedValue({
        status: 404,
        ok: false
      });

      const result = await verifyTrustline(mockPublicKey, customAsset);
      expect(result.exists).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('handles non-ok non-404 response', async () => {
      (fetch as jest.Mock).mockResolvedValue({
        status: 500,
        ok: false
      });

      const result = await verifyTrustline(mockPublicKey, customAsset);
      expect(result.exists).toBe(false);
      expect(result.error).toContain('Horizon error');
    });

    it('handles network errors', async () => {
      (fetch as jest.Mock).mockRejectedValue(new Error('Network failure'));

      const result = await verifyTrustline(mockPublicKey, customAsset);
      expect(result.exists).toBe(false);
      expect(result.error).toContain('Network error');
    });
  });

  describe('validateAssetPair', () => {
    it('validates matching native assets', () => {
      expect(validateAssetPair(NATIVE_ASSET, NATIVE_ASSET)).toBe(true);
    });

    it('rejects mismatched native and custom assets', () => {
      const custom = { code: 'USDC', issuer: 'G...', isNative: false };
      expect(validateAssetPair(NATIVE_ASSET, custom)).toBe(false);
    });

    it('validates matching custom assets', () => {
      const a = { code: 'USDC', issuer: 'G...', isNative: false };
      const b = { code: 'USDC', issuer: 'G...', isNative: false };
      expect(validateAssetPair(a, b)).toBe(true);
    });

    it('rejects mismatched codes', () => {
      const a = { code: 'USDC', issuer: 'G...', isNative: false };
      const b = { code: 'EURC', issuer: 'G...', isNative: false };
      expect(validateAssetPair(a, b)).toBe(false);
    });
  });
});
