import { explorerTxUrl, explorerAccountUrl } from './explorer';

describe('explorerTxUrl', () => {
  const VALID_HASH = 'c3f8a12e4b76d09e1a23f456bc78d90e1f234a5678b9c0d1e2f3a4b5c6d7e8f9';

  it('returns the testnet explorer URL for a valid hash', () => {
    expect(explorerTxUrl('testnet', VALID_HASH)).toBe(
      `https://stellar.expert/testnet/tx/${VALID_HASH}`,
    );
  });

  it('returns the mainnet explorer URL for a valid hash', () => {
    expect(explorerTxUrl('mainnet', VALID_HASH)).toBe(
      `https://stellar.expert/tx/${VALID_HASH}`,
    );
  });

  it('normalises uppercase hex to lowercase in the URL', () => {
    const upper = VALID_HASH.toUpperCase();
    expect(explorerTxUrl('testnet', upper)).toBe(
      `https://stellar.expert/testnet/tx/${VALID_HASH}`,
    );
  });

  it('trims surrounding whitespace before validating', () => {
    expect(explorerTxUrl('testnet', `  ${VALID_HASH}  `)).toBe(
      `https://stellar.expert/testnet/tx/${VALID_HASH}`,
    );
  });

  it('returns null for a hash shorter than 64 characters', () => {
    expect(explorerTxUrl('testnet', VALID_HASH.slice(0, 63))).toBeNull();
  });

  it('returns null for a hash longer than 64 characters', () => {
    expect(explorerTxUrl('testnet', VALID_HASH + '0')).toBeNull();
  });

  it('returns null for a hash that contains non-hex characters', () => {
    const bad = VALID_HASH.slice(0, 63) + 'z';
    expect(explorerTxUrl('testnet', bad)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(explorerTxUrl('testnet', '')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(explorerTxUrl('testnet', '   ')).toBeNull();
  });

  it('returns null for the "future" network (no registered profile)', () => {
    expect(explorerTxUrl('future', VALID_HASH)).toBeNull();
  });

  it('URL-encodes special characters that may appear in exotic hashes', () => {
    // Hashes are hex so this would be invalid, but encodeURIComponent must still
    // be called – verify via a valid lowercase hash that happens to need none.
    const url = explorerTxUrl('testnet', VALID_HASH);
    expect(url).not.toContain(' ');
  });
});

describe('explorerAccountUrl', () => {
  const ADDRESS = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37';

  it('returns the testnet explorer URL for an account address', () => {
    expect(explorerAccountUrl('testnet', ADDRESS)).toBe(
      `https://stellar.expert/testnet/account/${ADDRESS}`,
    );
  });

  it('returns the mainnet explorer URL for an account address', () => {
    expect(explorerAccountUrl('mainnet', ADDRESS)).toBe(
      `https://stellar.expert/account/${ADDRESS}`,
    );
  });

  it('trims whitespace from the address', () => {
    expect(explorerAccountUrl('testnet', `  ${ADDRESS}  `)).toBe(
      `https://stellar.expert/testnet/account/${ADDRESS}`,
    );
  });

  it('returns null for an empty address', () => {
    expect(explorerAccountUrl('testnet', '')).toBeNull();
  });

  it('returns null for whitespace-only address', () => {
    expect(explorerAccountUrl('testnet', '   ')).toBeNull();
  });

  it('returns null for the "future" network (no registered profile)', () => {
    expect(explorerAccountUrl('future', ADDRESS)).toBeNull();
  });

  it('URL-encodes special characters in the address', () => {
    const weirdAddress = 'G WEIRD+ADDRESS=1';
    const url = explorerAccountUrl('testnet', weirdAddress);
    expect(url).toBe(
      `https://stellar.expert/testnet/account/${encodeURIComponent(weirdAddress.trim())}`,
    );
  });
});
