import { Job, MockQueue } from './queue';
import { withCorrelationContext, withJobContext, withRetryContext, logger, type CorrelationContext } from './logger';
import { eventBus } from './event-bus';
import {
  streamEventOutbox,
  StreamEventOutbox,
  type StreamEventOutboxEntry,
} from './stream-event-outbox';

/**
 * Mock worker that processes jobs with correlation context restoration
 */
export class MockWorker {
  private queue: MockQueue;
  private processor: (job: Job) => Promise<void>;

  constructor(queue: MockQueue, processor: (job: Job) => Promise<void>) {
    this.queue = queue;
    this.processor = processor;
  }

  /**
   * Process a single job with correlation context restoration
   */
  async processJob(jobId: string): Promise<void> {
    const job = this.queue.getJob(jobId);
    
    if (!job) {
      logger.error('Job not found', { job_id: jobId });
      throw new Error(`Job ${jobId} not found`);
    }

    // Restore correlation context from job metadata
    await withCorrelationContext(job.correlationContext, async () => {
      // Add job-specific context
      withJobContext(job.id, job.queueName);
      
      // Add retry context if this is a retry
      if (job.attempts > 0) {
        withRetryContext(job.attempts);
      }

      logger.info('Worker processing job', {
        job_id: job.id,
        queue_name: job.queueName,
        attempt: job.attempts + 1,
        correlation_id: job.correlationContext.correlation_id,
        stream_id: job.correlationContext.stream_id,
      });

      try {
        await this.processor(job);
        
        logger.info('Job processed successfully', {
          job_id: job.id,
          queue_name: job.queueName,
          correlation_id: job.correlationContext.correlation_id,
        });
      } catch (error) {
        job.attempts++;
        
        logger.error('Job processing failed', {
          job_id: job.id,
          queue_name: job.queueName,
          attempt: job.attempts,
          correlation_id: job.correlationContext.correlation_id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        if (job.attempts >= job.maxAttempts) {
          logger.error('Job max retries exceeded', {
            job_id: job.id,
            queue_name: job.queueName,
            correlation_id: job.correlationContext.correlation_id,
            max_attempts: job.maxAttempts,
          });
          throw error;
        }

        // Retry logic would go here in a real system
        throw error;
      }
    });
  }

  /**
   * Process all jobs in the queue
   */
  async processAll(): Promise<void> {
    const jobs = this.queue.getAllJobs();
    
    logger.info('Worker starting batch processing', {
      queue_name: this.queue['queueName'],
      job_count: jobs.length,
    });

    for (const job of jobs) {
      try {
        await this.processJob(job.id);
      } catch (error) {
        // Continue processing other jobs even if one fails
        logger.error('Job failed in batch', {
          job_id: job.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    logger.info('Worker batch processing completed', {
      queue_name: this.queue['queueName'],
      job_count: jobs.length,
    });
  }
}

/**
 * Function that performs the actual publish for a drained outbox entry.
 * Defaults to replaying the event onto the live {@link eventBus}.
 */
export type OutboxPublishFn = (
  entry: StreamEventOutboxEntry,
) => void | Promise<void>;

export interface OutboxDrainResult {
  published: number;
  retried: number;
  dead: number;
}

/**
 * Drains the {@link streamEventOutbox} FIFO and publishes each event,
 * providing at-least-once delivery.
 *
 * Per entry: claim → publish → mark published. A publish failure is recorded
 * via `markFailed`, which schedules a backoff retry or moves the entry to the
 * DLQ once attempts are exhausted. Because an entry is only marked `published`
 * *after* a successful publish, a crash anywhere in the loop leaves the entry
 * to be re-claimed and redelivered (downstream consumers must dedupe on
 * `entry.id`).
 */
export class StreamEventOutboxWorker {
  private readonly outbox: StreamEventOutbox;
  private readonly publish: OutboxPublishFn;
  private readonly batchSize: number;

  constructor(
    opts: {
      outbox?: StreamEventOutbox;
      publish?: OutboxPublishFn;
      batchSize?: number;
    } = {},
  ) {
    this.outbox = opts.outbox ?? streamEventOutbox;
    this.publish = opts.publish ?? ((entry) => eventBus.publishFromOutbox(entry));
    this.batchSize = opts.batchSize ?? 50;
  }

  /**
   * Claim and publish one batch of outbox entries. Returns counts so callers
   * (e.g. a scheduler) can decide whether to keep draining.
   */
  async drainOnce(): Promise<OutboxDrainResult> {
    const batch = this.outbox.claimBatch(this.batchSize);
    const result: OutboxDrainResult = { published: 0, retried: 0, dead: 0 };

    for (const entry of batch) {
      // Restore the correlation context captured when the event was enqueued so
      // drain-time logs tie back to the originating request. Fall back to the
      // entry id when no correlation id was recorded.
      const context: CorrelationContext = {
        request_id: entry.correlationId ?? entry.id,
        correlation_id: entry.correlationId ?? entry.id,
        stream_id: entry.streamId,
      };

      await withCorrelationContext(context, async () => {
        try {
          await this.publish(entry);
          this.outbox.markPublished(entry.id);
          result.published += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          const updated = this.outbox.markFailed(entry.id, message);
          if (updated?.status === 'dead') {
            result.dead += 1;
          } else {
            result.retried += 1;
          }
        }
      });
    }

    return result;
  }

  /**
   * Repeatedly drain until no claimable entries remain (or `maxBatches` is
   * reached, guarding against an entry that keeps failing immediately).
   */
  async drainAll(maxBatches = 100): Promise<OutboxDrainResult> {
    const total: OutboxDrainResult = { published: 0, retried: 0, dead: 0 };

    for (let i = 0; i < maxBatches; i++) {
      const { published, retried, dead } = await this.drainOnce();
      total.published += published;
      total.retried += retried;
      total.dead += dead;
      // Stop once a batch did no useful work (nothing published this round).
      if (published === 0) break;
    }

    return total;
  }
}

/** Process-wide outbox worker bound to the shared event bus and outbox. */
export const streamEventOutboxWorker = new StreamEventOutboxWorker();
