import { getCorrelationId, logger, sdk } from './otel';
import { trace, context } from '@opentelemetry/api';

jest.mock('@opentelemetry/api', () => ({
  trace: {
    getSpan: jest.fn(),
  },
  context: {
    active: jest.fn(),
  },
}));

jest.mock('@opentelemetry/sdk-node', () => {
  return {
    NodeSDK: jest.fn().mockImplementation(() => ({
      start: jest.fn(),
      shutdown: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: jest.fn(),
}));

jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: jest.fn(),
}));

describe('OpenTelemetry Initialization', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should initialize NodeSDK without error', () => {
    expect(sdk).toBeDefined();
  });

  it('should get correlation id when span is active', () => {
    const mockTraceId = '1234567890abcdef';
    (trace.getSpan as jest.Mock).mockReturnValue({
      spanContext: () => ({ traceId: mockTraceId }),
    });

    const correlationId = getCorrelationId();
    expect(correlationId).toBe(mockTraceId);
  });

  it('should return undefined correlation id when no span is active', () => {
    (trace.getSpan as jest.Mock).mockReturnValue(undefined);

    const correlationId = getCorrelationId();
    expect(correlationId).toBeUndefined();
  });

  it('should log info with structured format', () => {
    (trace.getSpan as jest.Mock).mockReturnValue(undefined);
    logger.info('test info', { userId: 123 });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      JSON.stringify({ level: 'info', message: 'test info', correlationId: undefined, userId: 123 })
    );
  });

  it('should log error with structured format', () => {
    const mockTraceId = '1234567890abcdef';
    (trace.getSpan as jest.Mock).mockReturnValue({
      spanContext: () => ({ traceId: mockTraceId }),
    });

    logger.error('test error', { errorCode: 500 });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      JSON.stringify({ level: 'error', message: 'test error', correlationId: mockTraceId, errorCode: 500 })
    );
  });
});
