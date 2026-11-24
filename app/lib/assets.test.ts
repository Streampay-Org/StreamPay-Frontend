import {
  parseAssetString,
  verifyTrustline,
  NATIVE_ASSET,
  VERIFY_TRUSTLINE_TIMEOUT_MS,
} from './assets';

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

    it('handles non-2xx Horizon responses', async () => {
      (fetch as jest.Mock).mockResolvedValue({
        status: 503,
        ok: false,
      });

      const result = await verifyTrustline(mockPublicKey, customAsset);
      expect(result).toEqual({
        exists: false,
        error: 'Horizon error: 503',
      });
    });

    it('handles network errors', async () => {
      (fetch as jest.Mock).mockRejectedValue(new Error('Failed to fetch'));

      const result = await verifyTrustline(mockPublicKey, customAsset);
      expect(result).toEqual({
        exists: false,
        error: 'Network error: Failed to fetch',
      });
    });

    it('percent-encodes account id in the Horizon request URL', async () => {
      const specialKey = 'GABC/123?foo=bar#baz';
      (fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            balances: [{ asset_code: 'USDC', asset_issuer: 'GA5Z..' }],
          }),
      });

      const result = await verifyTrustline(
        specialKey,
        customAsset,
        'https://horizon-testnet.stellar.org'
      );

      expect(result.exists).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        `https://horizon-testnet.stellar.org/accounts/${encodeURIComponent(specialKey)}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('skips liquidity_pool_shares balances without throwing or false positives', async () => {
      (fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            balances: [
              { asset_type: 'native', balance: '100.0000000' },
              {
                asset_type: 'liquidity_pool_shares',
                liquidity_pool_id: 'abc123',
                balance: '50.0000000',
              },
            ],
          }),
      });

      const result = await verifyTrustline(mockPublicKey, customAsset);
      expect(result).toEqual({
        exists: false,
        error: 'Missing trustline for USDC.',
      });
    });

    it('finds a valid trustline when liquidity_pool_shares balances are also present', async () => {
      (fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            balances: [
              {
                asset_type: 'liquidity_pool_shares',
                liquidity_pool_id: 'abc123',
                balance: '50.0000000',
              },
              {
                asset_type: 'credit_alphanum4',
                asset_code: 'USDC',
                asset_issuer: 'GA5Z..',
              },
            ],
          }),
      });

      const result = await verifyTrustline(mockPublicKey, customAsset);
      expect(result).toEqual({ exists: true });
    });

    it('handles missing or non-array balances without throwing', async () => {
      (fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const result = await verifyTrustline(mockPublicKey, customAsset);
      expect(result).toEqual({
        exists: false,
        error: 'Missing trustline for USDC.',
      });
    });

    it('returns a distinct timeout error when Horizon hangs', async () => {
      jest.useFakeTimers();
      try {
        (fetch as jest.Mock).mockImplementation(
          (_url: string, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                const abortErr = new Error('The operation was aborted.');
                abortErr.name = 'AbortError';
                reject(abortErr);
              });
            })
        );

        const promise = verifyTrustline(mockPublicKey, customAsset);
        jest.advanceTimersByTime(VERIFY_TRUSTLINE_TIMEOUT_MS);

        const result = await promise;
        expect(result).toEqual({
          exists: false,
          error: `Horizon request timed out after ${VERIFY_TRUSTLINE_TIMEOUT_MS}ms.`,
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('returns an abort error when fetch rejects with AbortError', async () => {
      const abortErr = new Error('Aborted');
      abortErr.name = 'AbortError';
      (fetch as jest.Mock).mockRejectedValue(abortErr);

      const result = await verifyTrustline(mockPublicKey, customAsset);
      expect(result).toEqual({
        exists: false,
        error: 'Horizon request was aborted.',
      });
    });
  });
});
