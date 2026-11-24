const mockAwsKmsSigner = jest.fn((keyId: string, region?: string) => ({
  keyId,
  region,
  getPublicKey: async () => 'G_AWS_MOCK_PUBLIC_KEY',
  sign: async () => Buffer.alloc(64, 'b'),
  getProviderName: () => 'aws-kms',
}));

const mockLocalKmsSigner = jest.fn((secretKey: string, publicKey: string) => ({
  secretKey,
  publicKey,
  getPublicKey: async () => publicKey,
  sign: async () => Buffer.alloc(64, 'a'),
  getProviderName: () => 'local-mock',
}));

jest.mock('../aws-signer', () => ({ AwsKmsSigner: mockAwsKmsSigner }));
jest.mock('../local-signer', () => ({ LocalKmsSigner: mockLocalKmsSigner }));

const DEFAULT_MOCK_SECRET =
  'S_MOCK_SECRET_KEY_56_CHARS_LONG_AAAAAAAAAAAAAAAAAAAAAAA';
const MOCK_PUBLIC_KEY =
  'G_MOCK_PUBLIC_KEY_56_CHARS_LONG_AAAAAAAAAAAAAAAAAAAAAA';

const ENV_KEYS = [
  'KMS_PROVIDER',
  'KMS_KEY_ID',
  'KMS_REGION',
  'STELLAR_MOCK_SECRET',
] as const;

const originalEnv = { ...process.env };

function loadFactory(): typeof import('../factory') {
  let factory: typeof import('../factory') | undefined;
  jest.isolateModules(() => {
    factory = require('../factory') as typeof import('../factory');
  });
  return factory!;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('createKmsSigner', () => {
  it('builds an AwsKmsSigner for the aws-kms provider without calling AWS', () => {
    const { createKmsSigner } = loadFactory();

    const signer = createKmsSigner({
      provider: 'aws-kms',
      keyId: 'arn:aws:kms:key/abc',
      region: 'eu-west-1',
    });

    expect(mockAwsKmsSigner).toHaveBeenCalledWith(
      'arn:aws:kms:key/abc',
      'eu-west-1',
      undefined
    );
    expect(signer.getProviderName()).toBe('aws-kms');
    expect(mockLocalKmsSigner).not.toHaveBeenCalled();
  });

  it('rejects aws-kms without a keyId', () => {
    const { createKmsSigner } = loadFactory();

    expect(() => createKmsSigner({ provider: 'aws-kms' })).toThrow(
      'AWS KMS provider requires a keyId'
    );
    expect(() =>
      createKmsSigner({ provider: 'aws-kms', keyId: '' })
    ).toThrow('AWS KMS provider requires a keyId');
    expect(mockAwsKmsSigner).not.toHaveBeenCalled();
  });

  it('prefers config.mockSecret over STELLAR_MOCK_SECRET', () => {
    process.env.STELLAR_MOCK_SECRET = 'S_FROM_ENV';
    const { createKmsSigner } = loadFactory();

    const signer = createKmsSigner({
      provider: 'local-mock',
      mockSecret: 'S_FROM_CONFIG',
    });

    expect(mockLocalKmsSigner).toHaveBeenCalledWith(
      'S_FROM_CONFIG',
      MOCK_PUBLIC_KEY
    );
    expect(signer.getProviderName()).toBe('local-mock');
  });

  it('falls back to STELLAR_MOCK_SECRET when mockSecret is absent', () => {
    process.env.STELLAR_MOCK_SECRET = 'S_FROM_ENV';
    const { createKmsSigner } = loadFactory();

    createKmsSigner({ provider: 'local-mock' });

    expect(mockLocalKmsSigner).toHaveBeenCalledWith(
      'S_FROM_ENV',
      MOCK_PUBLIC_KEY
    );
  });

  it('falls back to the built-in mock secret when no secret is configured', () => {
    const { createKmsSigner } = loadFactory();

    createKmsSigner({ provider: 'local-mock' });

    expect(mockLocalKmsSigner).toHaveBeenCalledWith(
      DEFAULT_MOCK_SECRET,
      MOCK_PUBLIC_KEY
    );
  });

  it('rejects unknown providers', () => {
    const { createKmsSigner } = loadFactory();

    expect(() =>
      createKmsSigner({ provider: 'hsm' as never })
    ).toThrow('Unknown KMS provider: hsm');
  });
});

describe('getSigner', () => {
  it('defaults to local-mock and caches the singleton', () => {
    const { getSigner } = loadFactory();

    const first = getSigner();
    const second = getSigner();

    expect(first).toBe(second);
    expect(first.getProviderName()).toBe('local-mock');
    expect(mockLocalKmsSigner).toHaveBeenCalledTimes(1);
  });

  it('reads the provider and key configuration from the environment', () => {
    process.env.KMS_PROVIDER = 'aws-kms';
    process.env.KMS_KEY_ID = 'env-key-id';
    process.env.KMS_REGION = 'us-west-2';
    const { getSigner } = loadFactory();

    const signer = getSigner();

    expect(mockAwsKmsSigner).toHaveBeenCalledWith(
      'env-key-id',
      'us-west-2',
      undefined
    );
    expect(signer.getProviderName()).toBe('aws-kms');
    expect(getSigner()).toBe(signer);
    expect(mockAwsKmsSigner).toHaveBeenCalledTimes(1);
  });

  it('throws when KMS_PROVIDER=aws-kms has no KMS_KEY_ID', () => {
    process.env.KMS_PROVIDER = 'aws-kms';
    const { getSigner } = loadFactory();

    expect(() => getSigner()).toThrow('AWS KMS provider requires a keyId');
  });

  it('throws for an unsupported KMS_PROVIDER', () => {
    process.env.KMS_PROVIDER = 'vault';
    const { getSigner } = loadFactory();

    expect(() => getSigner()).toThrow('Unknown KMS provider: vault');
  });
});
