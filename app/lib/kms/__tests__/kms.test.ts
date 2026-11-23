import { LocalKmsSigner } from '../local-signer';
import { createKmsSigner, getSigner } from '../factory';

describe('KMS Signing Strategy', () => {
  const MOCK_SECRET = 'S_MOCK_SECRET_KEY_56_CHARS_LONG_AAAAAAAAAAAAAAAAAAAAAAA';
  const MOCK_PUBLIC = 'G_MOCK_PUBLIC_KEY_56_CHARS_LONG_AAAAAAAAAAAAAAAAAAAAAA';

  describe('LocalKmsSigner', () => {
    it('should return the public key', async () => {
      const signer = new LocalKmsSigner(MOCK_SECRET, MOCK_PUBLIC);
      const pubKey = await signer.getPublicKey();
      expect(pubKey).toBe(MOCK_PUBLIC);
    });

    it('should sign a payload with simulated latency', async () => {
      const signer = new LocalKmsSigner(MOCK_SECRET, MOCK_PUBLIC);
      const payload = Buffer.from('hello-stellar');
      
      const start = Date.now();
      const signature = await signer.sign(payload);
      const duration = Date.now() - start;

      expect(signature).toBeDefined();
      expect(signature.length).toBe(64);
      expect(duration).toBeGreaterThanOrEqual(50);
    });

    it('should report the local-mock provider name', () => {
      const signer = new LocalKmsSigner(MOCK_SECRET, MOCK_PUBLIC);
      expect(signer.getProviderName()).toBe('local-mock');
    });

    it('should reject an empty secret or public key', () => {
      expect(() => new LocalKmsSigner('', MOCK_PUBLIC))
        .toThrow('LocalKmsSigner requires both secretKey and publicKey');
      expect(() => new LocalKmsSigner(MOCK_SECRET, ''))
        .toThrow('LocalKmsSigner requires both secretKey and publicKey');
    });

    it('should return a deterministic 64-byte signature regardless of payload size', async () => {
      jest.useFakeTimers();
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const signer = new LocalKmsSigner(MOCK_SECRET, MOCK_PUBLIC);

        const smallSignature = signer.sign(Buffer.from('a'));
        const largeSignature = signer.sign(Buffer.alloc(1024, 1), {
          auditContext: { requestId: 'req-1' },
        });

        await jest.advanceTimersByTimeAsync(50);

        const [small, large] = await Promise.all([smallSignature, largeSignature]);

        expect(small.length).toBe(64);
        expect(large.length).toBe(64);
        expect(small.equals(large)).toBe(true);
        expect(logSpy).toHaveBeenCalledWith(
          '[LocalKmsSigner] Signing payload of size 1024',
          { requestId: 'req-1' }
        );
      } finally {
        logSpy.mockRestore();
        jest.useRealTimers();
      }
    });
  });

  describe('Factory', () => {
    it('should create a LocalKmsSigner by default', () => {
      const signer = getSigner();
      expect(signer.getProviderName()).toBe('local-mock');
    });

    it('should throw error for unknown provider', () => {
      expect(() => createKmsSigner({ provider: 'invalid' as any }))
        .toThrow('Unknown KMS provider: invalid');
    });

    it('should throw error for AWS KMS without keyId', () => {
      expect(() => createKmsSigner({ provider: 'aws-kms' }))
        .toThrow('AWS KMS provider requires a keyId');
    });
  });
});
