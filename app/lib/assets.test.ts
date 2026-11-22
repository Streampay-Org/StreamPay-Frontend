import { parseAssetString, verifyTrustline, NATIVE_ASSET } from './assets';

describe('Asset Engine', () => {
  describe('parseAssetString', () => {
    it('parses XLM correctly', () => {
      expect(parseAssetString('XLM')).toEqual(NATIVE_ASSET);
      expect(parseAssetString('xlm')).toEqual(NATIVE_ASSET);
      expect(parseAssetString('native')).toEqual(NATIVE_ASSET);
    });

    it.each([
      ['one-character code', 'A', 'A'],
      ['12-character code', 'ABCDEFGHIJKL', 'ABCDEFGHIJKL'],
      ['mixed-case code', 'uSdC', 'USDC'],
    ])('parses a valid %s', (_description, code, normalizedCode) => {
      const issuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335XOP3IA2M3QC2ED2AAA7Z5TJH';
      expect(parseAssetString(`${code}:${issuer}`)).toEqual({
        code: normalizedCode,
        issuer,
        isNative: false,
      });
    });

    it.each([
      ['missing code', ':GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335XOP3IA2M3QC2ED2AAA7Z5TJH'],
      ['13-character code', 'ABCDEFGHIJKLM:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335XOP3IA2M3QC2ED2AAA7Z5TJH'],
      ['space in code', 'US DC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335XOP3IA2M3QC2ED2AAA7Z5TJH'],
      ['symbol in code', 'US$D:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335XOP3IA2M3QC2ED2AAA7Z5TJH'],
      ['hyphen in code', 'US-DC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335XOP3IA2M3QC2ED2AAA7Z5TJH'],
      ['underscore in code', 'US_DC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335XOP3IA2M3QC2ED2AAA7Z5TJH'],
      ['unicode letter in code', 'Å:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335XOP3IA2M3QC2ED2AAA7Z5TJH'],
      ['missing issuer', 'USDC:'],
      ['extra colon', 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335XOP3IA2M3QC2ED2AAA7Z5TJH:extra'],
      ['missing separator', 'USDC'],
      ['invalid issuer', 'USDC:short'],
    ])('rejects a %s with the existing error', (_description, assetString) => {
      expect(() => parseAssetString(assetString)).toThrow('Invalid asset format:');
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
  });
});
