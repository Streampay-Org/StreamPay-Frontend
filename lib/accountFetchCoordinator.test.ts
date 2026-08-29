import {
  AccountFetchCoordinator,
  AccountSwitchedError,
  RequestAbortedError,
} from './accountFetchCoordinator';

describe('AccountFetchCoordinator', () => {
  let coordinator: AccountFetchCoordinator;

  beforeEach(() => {
    coordinator = new AccountFetchCoordinator();
  });

  afterEach(() => {
    coordinator.abortAll();
  });

  it('successfully executes a fetch for the active account', async () => {
    coordinator.switchAccount('GA_ALICE');

    const result = await coordinator.execute('GA_ALICE', async () => {
      return { streams: ['stream-1', 'stream-2'] };
    });

    expect(result).toEqual({ streams: ['stream-1', 'stream-2'] });
  });

  it('rejects immediately if requested account does not match active account', async () => {
    coordinator.switchAccount('GA_ALICE');

    await expect(
      coordinator.execute('GA_BOB', async () => {
        return { streams: [] };
      })
    ).rejects.toThrow(AccountSwitchedError);
  });

  it('aborts and discards in-flight fetch when account switches before response', async () => {
    coordinator.switchAccount('GA_ALICE');

    let aliceAborted = false;

    const aliceFetch = coordinator.execute('GA_ALICE', async (signal) => {
      signal.addEventListener('abort', () => {
        aliceAborted = true;
      });
      // Simulate network delay
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { owner: 'GA_ALICE', data: 'alice-secret-data' };
    });

    // Attach catch handler immediately to prevent unhandled rejection during switch
    const aliceCatch = aliceFetch.catch((err) => err);

    // Switch account to Bob while Alice's fetch is in-flight
    coordinator.switchAccount('GA_BOB');

    const bobFetch = coordinator.execute('GA_BOB', async () => {
      return { owner: 'GA_BOB', data: 'bob-data' };
    });

    const [bobResult, aliceError] = await Promise.all([bobFetch, aliceCatch]);
    expect(bobResult).toEqual({ owner: 'GA_BOB', data: 'bob-data' });
    expect(aliceError).toBeInstanceOf(AccountSwitchedError);
    expect(aliceAborted).toBe(true);
  });

  it('handles rapid oscillations (A -> B -> A) deterministically', async () => {
    coordinator.switchAccount('GA_ALICE');

    // 1st Alice fetch (slow)
    const aliceFetch1 = coordinator.execute('GA_ALICE', async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { generation: 1, account: 'GA_ALICE' };
    });
    const alice1Catch = aliceFetch1.catch((err) => err);

    // Switch to Bob (slow)
    coordinator.switchAccount('GA_BOB');
    const bobFetch = coordinator.execute('GA_BOB', async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { generation: 2, account: 'GA_BOB' };
    });
    const bobCatch = bobFetch.catch((err) => err);

    // Switch back to Alice (fast)
    coordinator.switchAccount('GA_ALICE');
    const aliceFetch2 = coordinator.execute('GA_ALICE', async () => {
      return { generation: 3, account: 'GA_ALICE' };
    });

    const [resultAlice2, errAlice1, errBob] = await Promise.all([
      aliceFetch2,
      alice1Catch,
      bobCatch,
    ]);

    expect(resultAlice2).toEqual({ generation: 3, account: 'GA_ALICE' });
    expect(errAlice1).toBeInstanceOf(AccountSwitchedError);
    expect(errBob).toBeInstanceOf(AccountSwitchedError);
  });

  it('aborts all in-flight requests when user disconnects (switch to null)', async () => {
    coordinator.switchAccount('GA_ALICE');

    const inFlight = coordinator.execute('GA_ALICE', async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { data: 'should not resolve' };
    });
    const inFlightCatch = inFlight.catch((err) => err);

    coordinator.switchAccount(null);

    const err = await inFlightCatch;
    expect(err).toBeInstanceOf(AccountSwitchedError);
    expect(coordinator.getActiveAccountId()).toBeNull();
  });

  it('deduplicates concurrent requests with same dedupKey for the active account', async () => {
    coordinator.switchAccount('GA_ALICE');

    let executionCount = 0;
    const fetcher = async () => {
      executionCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { streams: ['stream-shared'] };
    };

    const promise1 = coordinator.execute('GA_ALICE', fetcher, { dedupKey: 'GET:/api/streams' });
    const promise2 = coordinator.execute('GA_ALICE', fetcher, { dedupKey: 'GET:/api/streams' });

    const [res1, res2] = await Promise.all([promise1, promise2]);

    expect(res1).toEqual({ streams: ['stream-shared'] });
    expect(res2).toEqual({ streams: ['stream-shared'] });
    expect(executionCount).toBe(1);
  });

  it('cancels retry loop immediately when account switches during retry sleep', async () => {
    coordinator.switchAccount('GA_ALICE');

    let attemptCount = 0;
    const retryFetch = coordinator.execute(
      'GA_ALICE',
      async () => {
        attemptCount++;
        throw new Error('Transient network failure');
      },
      {
        retries: 3,
        retryDelayMs: 50,
      }
    );
    const retryCatch = retryFetch.catch((err) => err);

    // Give time for attempt 1 to fail and enter retry delay
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Switch account during retry sleep
    coordinator.switchAccount('GA_BOB');

    const err = await retryCatch;
    expect(err).toBeInstanceOf(AccountSwitchedError);
    expect(attemptCount).toBe(1); // Should not have continued to attempt 2 or 3
  });

  it('aborts on timeout when timeoutMs is exceeded', async () => {
    coordinator.switchAccount('GA_ALICE');

    const slowFetch = coordinator.execute(
      'GA_ALICE',
      async (signal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new RequestAbortedError());
          });
        });
        return { ok: true };
      },
      { timeoutMs: 25 }
    );

    await expect(slowFetch).rejects.toThrow();
  });
});
