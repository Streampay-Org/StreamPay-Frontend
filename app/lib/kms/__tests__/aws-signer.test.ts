import { AwsKmsSigner } from '../aws-signer';
import { KmsAccessError, KmsKeyConfigError, KmsTransientError } from '../errors';
import { encodeEd25519PublicKeyStrkey } from '../../stellar-strkey';

const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');

function spkiFor(raw: Buffer): Buffer {
  return Buffer.concat([ED25519_SPKI_HEADER, raw]);
}

function makeFakeClient(handler: (command: { constructor: { name: string }; input: any }) => Promise<any>) {
  const send = jest.fn(async (command: any) => handler({ constructor: command.constructor, input: command.input }));
  return { send };
}

function awsError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

const RAW_KEY = Buffer.alloc(32, 0x11);

describe('AwsKmsSigner', () => {
  describe('getPublicKey', () => {
    it('converts SPKI to the expected Stellar G-address (test vector)', async () => {
      const client = makeFakeClient(async () => ({
        KeySpec: 'ECC_NIST_EDWARDS25519',
        KeyUsage: 'SIGN_VERIFY',
        PublicKey: spkiFor(RAW_KEY),
      }));
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any);
      const address = await signer.getPublicKey();
      expect(address).toBe(encodeEd25519PublicKeyStrkey(RAW_KEY));
      expect(address).toMatch(/^G[A-Z2-7]{55}$/);
    });

    it('caches the public key and deduplicates concurrent calls', async () => {
      const client = makeFakeClient(async () => ({
        KeySpec: 'ECC_NIST_EDWARDS25519',
        KeyUsage: 'SIGN_VERIFY',
        PublicKey: spkiFor(RAW_KEY),
      }));
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any);
      const [a, b] = await Promise.all([signer.getPublicKey(), signer.getPublicKey()]);
      expect(a).toBe(b);
      expect(client.send).toHaveBeenCalledTimes(1);
      await signer.getPublicKey();
      expect(client.send).toHaveBeenCalledTimes(1);
    });

    it('rejects an RSA key spec with KmsKeyConfigError', async () => {
      const client = makeFakeClient(async () => ({
        KeySpec: 'RSA_2048',
        KeyUsage: 'SIGN_VERIFY',
        PublicKey: spkiFor(RAW_KEY),
      }));
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any);
      await expect(signer.getPublicKey()).rejects.toBeInstanceOf(KmsKeyConfigError);
    });

    it('rejects wrong key usage', async () => {
      const client = makeFakeClient(async () => ({
        KeySpec: 'ECC_NIST_EDWARDS25519',
        KeyUsage: 'ENCRYPT_DECRYPT',
        PublicKey: spkiFor(RAW_KEY),
      }));
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any);
      await expect(signer.getPublicKey()).rejects.toBeInstanceOf(KmsKeyConfigError);
    });

    it('rejects an empty PublicKey', async () => {
      const client = makeFakeClient(async () => ({
        KeySpec: 'ECC_NIST_EDWARDS25519',
        KeyUsage: 'SIGN_VERIFY',
        PublicKey: new Uint8Array(0),
      }));
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any);
      await expect(signer.getPublicKey()).rejects.toBeInstanceOf(KmsKeyConfigError);
    });

    it('maps NotFoundException to a non-retryable KmsKeyConfigError', async () => {
      const client = makeFakeClient(async () => {
        throw awsError('NotFoundException');
      });
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any);
      await expect(signer.getPublicKey()).rejects.toBeInstanceOf(KmsKeyConfigError);
      expect(client.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('sign', () => {
    it('returns the KMS signature bytes verbatim using RAW Ed25519 signing', async () => {
      const sig = Buffer.alloc(64, 0x7f);
      const client = makeFakeClient(async ({ input }) => {
        expect(input).toMatchObject({
          KeyId: 'key-1',
          MessageType: 'RAW',
          SigningAlgorithm: 'ED25519_SHA_512',
        });
        return { Signature: sig };
      });
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any);
      const out = await signer.sign(Buffer.from('payload'), { auditContext: { op: 'test' } });
      expect(Buffer.isBuffer(out)).toBe(true);
      expect(out.equals(sig)).toBe(true);
    });

    it('rejects a malformed signature length', async () => {
      const client = makeFakeClient(async () => ({ Signature: new Uint8Array(32) }));
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any);
      await expect(signer.sign(Buffer.from('x'))).rejects.toBeInstanceOf(KmsTransientError);
    });

    it('retries throttling then succeeds', async () => {
      let calls = 0;
      const client = makeFakeClient(async () => {
        calls += 1;
        if (calls < 3) throw awsError('ThrottlingException');
        return { Signature: Buffer.alloc(64, 1) };
      });
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any, { maxAttempts: 3 });
      const out = await signer.sign(Buffer.from('x'));
      expect(out.length).toBe(64);
      expect(client.send).toHaveBeenCalledTimes(3);
    });

    it('fails after exhausting throttling retries', async () => {
      const client = makeFakeClient(async () => {
        throw awsError('ThrottlingException');
      });
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any, { maxAttempts: 3 });
      await expect(signer.sign(Buffer.from('x'))).rejects.toBeInstanceOf(KmsTransientError);
      expect(client.send).toHaveBeenCalledTimes(3);
    });

    it('maps AccessDeniedException to a non-retryable KmsAccessError', async () => {
      const client = makeFakeClient(async () => {
        throw awsError('AccessDeniedException');
      });
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any);
      await expect(signer.sign(Buffer.from('x'))).rejects.toBeInstanceOf(KmsAccessError);
      expect(client.send).toHaveBeenCalledTimes(1);
    });

    it('maps DisabledException to a non-retryable KmsKeyConfigError', async () => {
      const client = makeFakeClient(async () => {
        throw awsError('DisabledException');
      });
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any);
      await expect(signer.sign(Buffer.from('x'))).rejects.toBeInstanceOf(KmsKeyConfigError);
      expect(client.send).toHaveBeenCalledTimes(1);
    });

    it('treats an aborted call as a retryable timeout', async () => {
      const client = makeFakeClient(async () => {
        // never resolves; rely on the per-call timeout abort
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(awsError('AbortError')), 50);
        });
      });
      const signer = new AwsKmsSigner('key-1', 'us-east-1', client as any, { timeoutMs: 10, maxAttempts: 1 });
      await expect(signer.sign(Buffer.from('x'))).rejects.toBeInstanceOf(KmsTransientError);
    });
  });

  it('reports the aws-kms provider name', () => {
    expect(new AwsKmsSigner('key-1').getProviderName()).toBe('aws-kms');
  });
});
