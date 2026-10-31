import { CorrelationContext, getCorrelationContext, logger } from './logger';

// Mock job interface
export interface Job<T = unknown> {
  id: string;
  data: T;
  correlationContext: CorrelationContext;
  queueName: string;
  createdAt: string;
  attempts: number;
  maxAttempts: number;
}

export interface DeadLetteredJob<T = unknown> extends Job<T> {
  failedAt: string;
  reason: string;
}

export class QueueCapacityError extends Error {
  constructor(queueName: string, readonly capacity: number) {
    super(`Queue ${queueName} is at capacity (${capacity})`);
    this.name = 'QueueCapacityError';
  }
}

function resolveMaxActiveJobs(value: string | undefined): number {
  const parsed = Number(value ?? 1000);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1000;
}

// Mock queue for demonstration
export class MockQueue {
  private jobs: Map<string, Job> = new Map();
  private deadLetters: Map<string, DeadLetteredJob> = new Map();
  private queueName: string;

  constructor(queueName: string, private readonly maxActiveJobs = resolveMaxActiveJobs(process.env.QUEUE_MAX_ACTIVE_JOBS)) {
    this.queueName = queueName;
  }

  /**
   * Add a job to the queue with correlation context
   */
  async add<T>(jobName: string, data: T, options: { jobId?: string; maxAttempts?: number } = {}): Promise<Job<T>> {
    const context = getCorrelationContext();
    
    if (!context) {
      throw new Error('No correlation context available when enqueuing job');
    }

    const jobId = options.jobId || `job-${crypto.randomUUID()}`;

    const existing = this.jobs.get(jobId) as Job<T> | undefined;
    if (existing) {
      logger.info('Duplicate job enqueue ignored', {
        job_id: jobId,
        queue_name: this.queueName,
        job_name: jobName,
        correlation_id: context.correlation_id,
      });
      return existing;
    }

    if (this.deadLetters.has(jobId)) {
      logger.warn('Dead-lettered job enqueue rejected', {
        job_id: jobId,
        queue_name: this.queueName,
        job_name: jobName,
        correlation_id: context.correlation_id,
      });
      throw new Error(`Job ${jobId} is dead-lettered and cannot be re-enqueued`);
    }

    if (this.jobs.size >= this.maxActiveJobs) {
      logger.error('Job enqueue rejected: queue capacity exceeded', {
        queue_name: this.queueName,
        job_name: jobName,
        capacity: this.maxActiveJobs,
        active_jobs: this.jobs.size,
        correlation_id: context.correlation_id,
      });
      throw new QueueCapacityError(this.queueName, this.maxActiveJobs);
    }
    
    const job: Job<T> = {
      id: jobId,
      data,
      correlationContext: { ...context }, // Copy context to preserve it
      queueName: this.queueName,
      createdAt: new Date().toISOString(),
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
    };

    this.jobs.set(jobId, job);

    logger.info('Job enqueued', {
      job_id: jobId,
      queue_name: this.queueName,
      job_name: jobName,
      correlation_id: context.correlation_id,
      stream_id: context.stream_id,
    });

    return job;
  }

  /**
   * Get a job by ID
   */
  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Get all jobs in the queue
   */
  getAllJobs(): Job[] {
    return Array.from(this.jobs.values());
  }

  completeJob(jobId: string): boolean {
    return this.jobs.delete(jobId);
  }

  deadLetterJob(jobId: string, reason: string): DeadLetteredJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    const deadLetter: DeadLetteredJob = {
      ...job,
      failedAt: new Date().toISOString(),
      reason,
    };
    this.deadLetters.set(jobId, deadLetter);
    this.jobs.delete(jobId);

    logger.error('Job moved to dead letter queue', {
      job_id: job.id,
      queue_name: this.queueName,
      attempts: job.attempts,
      max_attempts: job.maxAttempts,
      reason,
      correlation_id: job.correlationContext.correlation_id,
    });

    return deadLetter;
  }

  getDeadLetter(jobId: string): DeadLetteredJob | undefined {
    return this.deadLetters.get(jobId);
  }

  getDeadLetters(): DeadLetteredJob[] {
    return Array.from(this.deadLetters.values());
  }

  getStats() {
    return {
      queueName: this.queueName,
      active: this.jobs.size,
      deadLettered: this.deadLetters.size,
      capacity: this.maxActiveJobs,
    };
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.jobs.clear();
    this.deadLetters.clear();
  }
}

// Mock queue instances
export const settlementQueue = new MockQueue('settlement-queue');
export const webhookQueue = new MockQueue('webhook-queue');
export const retryQueue = new MockQueue('retry-queue');
