import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MockQueue, QueueCapacityError, settlementQueue } from './queue';
import { withCorrelationContext, type CorrelationContext } from './logger';

const vi = jest;

describe('Mock Queue System', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    settlementQueue.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Job enqueue with correlation context', () => {
    it('should enqueue job with correlation context', async () => {
      const context: CorrelationContext = {
        request_id: 'req-1',
        correlation_id: 'corr-1',
        stream_id: 'stream-123',
      };

      await withCorrelationContext(context, async () => {
        const job = await settlementQueue.add('settlement', { streamId: 'stream-123' });

        expect(job.id).toBeDefined();
        expect(job.correlationContext.correlation_id).toBe('corr-1');
        expect(job.correlationContext.stream_id).toBe('stream-123');
        expect(job.queueName).toBe('settlement-queue');
      });
    });

    it('should throw error when no correlation context available', async () => {
      await expect(
        settlementQueue.add('settlement', { streamId: 'stream-123' })
      ).rejects.toThrow('No correlation context available when enqueuing job');
    });

    it('should reject new jobs when active queue capacity is reached', async () => {
      const queue = new MockQueue('bounded-queue', 1);
      const context: CorrelationContext = {
        request_id: 'req-1',
        correlation_id: 'corr-1',
      };

      await withCorrelationContext(context, async () => {
        await queue.add('test-job', { data: 'first' });

        await expect(queue.add('test-job', { data: 'second' })).rejects.toThrow(QueueCapacityError);
        expect(queue.getAllJobs()).toHaveLength(1);
        expect(queue.getStats()).toMatchObject({ active: 1, deadLettered: 0, capacity: 1 });
      });
    });

    it('should return the existing active job for duplicate job IDs without growing the queue', async () => {
      const queue = new MockQueue('dedupe-queue', 10);
      const context: CorrelationContext = {
        request_id: 'req-1',
        correlation_id: 'corr-1',
      };

      await withCorrelationContext(context, async () => {
        const first = await queue.add('test-job', { data: 'first' }, { jobId: 'stable-job-id' });
        const duplicate = await queue.add('test-job', { data: 'retry' }, { jobId: 'stable-job-id' });

        expect(duplicate).toBe(first);
        expect(queue.getAllJobs()).toHaveLength(1);
      });
    });

    it('should reject duplicate enqueue for a dead-lettered job ID', async () => {
      const queue = new MockQueue('dedupe-dlq-queue', 10);
      const context: CorrelationContext = {
        request_id: 'req-1',
        correlation_id: 'corr-1',
      };

      await withCorrelationContext(context, async () => {
        const job = await queue.add('test-job', { data: 'first' }, { jobId: 'dead-job-id' });
        queue.deadLetterJob(job.id, 'terminal failure');

        await expect(
          queue.add('test-job', { data: 'retry' }, { jobId: 'dead-job-id' }),
        ).rejects.toThrow('dead-lettered');
        expect(queue.getAllJobs()).toHaveLength(0);
        expect(queue.getDeadLetters()).toHaveLength(1);
      });
    });

    it('should preserve correlation context in job metadata', async () => {
      const context: CorrelationContext = {
        request_id: 'req-1',
        correlation_id: 'corr-1',
        stream_id: 'stream-123',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      };

      await withCorrelationContext(context, async () => {
        const job = await settlementQueue.add('settlement', { streamId: 'stream-123' });

        expect(job.correlationContext.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
      });
    });

    it('should log job enqueue with correlation metadata', async () => {
      const context: CorrelationContext = {
        request_id: 'req-1',
        correlation_id: 'corr-1',
        stream_id: 'stream-123',
      };

      const consoleSpy = vi.spyOn(console, 'log');

      await withCorrelationContext(context, async () => {
        await settlementQueue.add('settlement', { streamId: 'stream-123' });
      });

      const logCall = consoleSpy.mock.calls[0][0];
      const logEntry = JSON.parse(logCall);

      expect(logEntry.message).toBe('Job enqueued');
      expect(logEntry.job_id).toBeDefined();
      expect(logEntry.queue_name).toBe('settlement-queue');
      expect(logEntry.correlation_id).toBe('corr-1');
      expect(logEntry.stream_id).toBe('stream-123');
    });
  });

  describe('Job retrieval', () => {
    it('should retrieve job by ID', async () => {
      const context: CorrelationContext = {
        request_id: 'req-1',
        correlation_id: 'corr-1',
      };

      await withCorrelationContext(context, async () => {
        const job = await settlementQueue.add('settlement', { streamId: 'stream-123' });
        const retrieved = settlementQueue.getJob(job.id);

        expect(retrieved).toEqual(job);
      });
    });

    it('should return undefined for non-existent job', () => {
      const retrieved = settlementQueue.getJob('non-existent');
      expect(retrieved).toBeUndefined();
    });

    it('should retrieve all jobs', async () => {
      const context: CorrelationContext = {
        request_id: 'req-1',
        correlation_id: 'corr-1',
      };

      await withCorrelationContext(context, async () => {
        await settlementQueue.add('settlement', { streamId: 'stream-1' });
        await settlementQueue.add('settlement', { streamId: 'stream-2' });

        const jobs = settlementQueue.getAllJobs();
        expect(jobs).toHaveLength(2);
      });
    });
  });

  describe('Queue clearing', () => {
    it('should clear all jobs', async () => {
      const context: CorrelationContext = {
        request_id: 'req-1',
        correlation_id: 'corr-1',
      };

      await withCorrelationContext(context, async () => {
        await settlementQueue.add('settlement', { streamId: 'stream-1' });
        await settlementQueue.add('settlement', { streamId: 'stream-2' });

        settlementQueue.clear();

        const jobs = settlementQueue.getAllJobs();
        expect(jobs).toHaveLength(0);
      });
    });
  });

  describe('Dead letter queue', () => {
    it('should move a failed job out of active jobs and into dead letters', async () => {
      const queue = new MockQueue('dlq-queue');
      const context: CorrelationContext = {
        request_id: 'req-1',
        correlation_id: 'corr-1',
      };

      await withCorrelationContext(context, async () => {
        const job = await queue.add('test-job', { data: 'test' });
        job.attempts = job.maxAttempts;

        const deadLetter = queue.deadLetterJob(job.id, 'processor failed');

        expect(deadLetter).toMatchObject({ id: job.id, reason: 'processor failed' });
        expect(queue.getAllJobs()).toHaveLength(0);
        expect(queue.getDeadLetters()).toHaveLength(1);
      });
    });
  });
});
