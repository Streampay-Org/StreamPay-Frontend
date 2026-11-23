import { ReconciliationService } from './reconcile';
import { dbClient } from '../../lib/dbClient';
import { onChainClient } from '../../lib/onChainClient';
import { ContractStreamStatus } from '../../types';

jest.mock('../../lib/dbClient');
jest.mock('../../lib/onChainClient');

describe('ReconciliationService', () => {
  let service: ReconciliationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ReconciliationService();
  });

  it('should return SUCCESS when DB and on-chain balances match', async () => {
    (dbClient.getStreams as jest.Mock).mockResolvedValue([
      { id: 's1', total_amount: '100', released_amount: '50', status: 'ACTIVE' }
    ]);
    (onChainClient.fetchStream as jest.Mock).mockResolvedValue({
      id: 's1', total_amount: 100n, released_amount: 50n, status: ContractStreamStatus.ACTIVE
    });

    const report = await service.runReconciliation();
    
    expect(report.status).toBe('SUCCESS');
    expect(report.totalStreamsChecked).toBe(1);
    expect(report.mismatches).toHaveLength(0);
  });

  it('should detect mismatches in released_amount', async () => {
    (dbClient.getStreams as jest.Mock).mockResolvedValue([
      { id: 's1', total_amount: '100', released_amount: '50', status: 'ACTIVE' }
    ]);
    (onChainClient.fetchStream as jest.Mock).mockResolvedValue({
      id: 's1', total_amount: 100n, released_amount: 60n, status: ContractStreamStatus.ACTIVE
    });

    const report = await service.runReconciliation();
    
    expect(report.status).toBe('MISMATCH_FOUND');
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toMatchObject({
      streamId: 's1',
      field: 'released_amount',
      dbValue: 50n,
      onChainValue: 60n
    });
  });

  it('should respect tolerance levels', async () => {
    service = new ReconciliationService({ tolerance: 5n });
    (dbClient.getStreams as jest.Mock).mockResolvedValue([
      { id: 's1', total_amount: '100', released_amount: '50', status: 'ACTIVE' }
    ]);
    (onChainClient.fetchStream as jest.Mock).mockResolvedValue({
      id: 's1', total_amount: 100n, released_amount: 53n, status: ContractStreamStatus.ACTIVE
    });

    const report = await service.runReconciliation();
    
    expect(report.status).toBe('SUCCESS');
    expect(report.mismatches).toHaveLength(0);
  });

  it('should fail if on-chain fetch fails', async () => {
    (dbClient.getStreams as jest.Mock).mockResolvedValue([
      { id: 's1', total_amount: '100', released_amount: '50', status: 'ACTIVE' }
    ]);
    (onChainClient.fetchStream as jest.Mock).mockRejectedValue(new Error('Network Error'));

    const report = await service.runReconciliation();
    
    expect(report.status).toBe('FAILED');
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].error).toBe('Network Error');
  });

  it('should detect missing on-chain records', async () => {
    (dbClient.getStreams as jest.Mock).mockResolvedValue([
      { id: 's_missing', total_amount: '100', released_amount: '50', status: 'ACTIVE' }
    ]);
    (onChainClient.fetchStream as jest.Mock).mockResolvedValue(null);

    const report = await service.runReconciliation();

    expect(report.status).toBe('MISMATCH_FOUND');
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toMatchObject({
      streamId: 's_missing',
      field: 'presence',
      dbValue: 'exists',
      onChainValue: 'missing'
    });
  });

  it('should detect escrow invariant violations (negative balances)', async () => {
    (dbClient.getStreams as jest.Mock).mockResolvedValue([
      { id: 's1', total_amount: '100', released_amount: '50', status: 'ACTIVE' }
    ]);
    (onChainClient.fetchStream as jest.Mock).mockResolvedValue({
      id: 's1', total_amount: -100n, released_amount: 50n, status: ContractStreamStatus.ACTIVE
    });

    const report = await service.runReconciliation();

    expect(report.status).toBe('MISMATCH_FOUND');
    expect(report.mismatches).toHaveLength(2); // total_amount mismatch AND escrow-invariant violation
    expect(report.mismatches).toContainEqual(expect.objectContaining({
      field: 'escrow-invariant',
      onChainValue: expect.stringContaining('Total amount cannot be negative')
    }));
  });

  it('should detect escrow invariant violations (over-release)', async () => {
    (dbClient.getStreams as jest.Mock).mockResolvedValue([
      { id: 's1', total_amount: '100', released_amount: '50', status: 'ACTIVE' }
    ]);
    (onChainClient.fetchStream as jest.Mock).mockResolvedValue({
      id: 's1', total_amount: 100n, released_amount: 150n, status: ContractStreamStatus.ACTIVE
    });

    const report = await service.runReconciliation();

    expect(report.status).toBe('MISMATCH_FOUND');
    expect(report.mismatches.some(m => m.field === 'escrow-invariant')).toBe(true);
  });

  it('should run reconciliation for a single stream by id', async () => {
    (dbClient.getStreamById as jest.Mock).mockResolvedValue(
      { id: 's1', total_amount: '100', released_amount: '50', status: 'ACTIVE' }
    );
    (onChainClient.fetchStream as jest.Mock).mockResolvedValue({
      id: 's1', total_amount: 100n, released_amount: 50n, status: ContractStreamStatus.ACTIVE
    });

    const report = await service.runReconciliation({ streamId: 's1' });

    expect(report.status).toBe('SUCCESS');
    expect(report.totalStreamsChecked).toBe(1);
    expect(dbClient.getStreamById).toHaveBeenCalledWith('s1');
  });

  it('should not persist status if dryRun is true', async () => {
    (dbClient.getStreams as jest.Mock).mockResolvedValue([
      { id: 's1', total_amount: '100', released_amount: '50', status: 'ACTIVE' }
    ]);
    (onChainClient.fetchStream as jest.Mock).mockResolvedValue({
      id: 's1', total_amount: 100n, released_amount: 50n, status: ContractStreamStatus.ACTIVE
    });

    const report = await service.runReconciliation({ dryRun: true });

    expect(report.status).toBe('SUCCESS');
    expect(dbClient.updateLastRunStatus).not.toHaveBeenCalled();
  });

  it('should persist status if dryRun is false', async () => {
    (dbClient.getStreams as jest.Mock).mockResolvedValue([
      { id: 's1', total_amount: '100', released_amount: '50', status: 'ACTIVE' }
    ]);
    (onChainClient.fetchStream as jest.Mock).mockResolvedValue({
      id: 's1', total_amount: 100n, released_amount: 50n, status: ContractStreamStatus.ACTIVE
    });

    const report = await service.runReconciliation({ dryRun: false });

    expect(report.status).toBe('SUCCESS');
    expect(dbClient.updateLastRunStatus).toHaveBeenCalledWith('SUCCESS', expect.any(Number));
  });

  it('should fail single-stream reconciliation if not found in DB', async () => {
    (dbClient.getStreamById as jest.Mock).mockResolvedValue(null);
    const report = await service.runReconciliation({ streamId: 'non-existent' });
    expect(report.status).toBe('FAILED');
    expect(report.errors[0].error).toContain('Stream not found in DB');
  });

  it('should handle single-stream DB fetch error', async () => {
    (dbClient.getStreamById as jest.Mock).mockRejectedValue(new Error('DB Error'));
    const report = await service.runReconciliation({ streamId: 's1' });
    expect(report.status).toBe('FAILED');
    expect(report.errors[0].error).toBe('DB Error');
  });

  it('should handle all-streams DB fetch error', async () => {
    (dbClient.getStreams as jest.Mock).mockRejectedValue(new Error('Fetch Error'));
    const report = await service.runReconciliation();
    expect(report.status).toBe('FAILED');
    expect(report.errors[0].error).toBe('Fetch Error');
  });

  it('should handle single stream fetch on-chain error in page loop', async () => {
    (dbClient.getStreams as jest.Mock).mockResolvedValue([
      { id: 's1', total_amount: '100', released_amount: '50', status: 'ACTIVE' }
    ]);
    (onChainClient.fetchStream as jest.Mock).mockRejectedValue(new Error('RPC Error'));
    const report = await service.runReconciliation();
    expect(report.status).toBe('FAILED');
    expect(report.errors[0].error).toBe('RPC Error');
  });

  it('should log warning if updateLastRunStatus throws', async () => {
    (dbClient.getStreams as jest.Mock).mockResolvedValue([]);
    (dbClient.updateLastRunStatus as jest.Mock).mockRejectedValue(new Error('Update Failed'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    
    await service.runReconciliation({ dryRun: false });
    
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to update last run status in DB:'), expect.any(Error));
    consoleSpy.mockRestore();
  });

  it('should detect recipient address mismatch', async () => {
    (dbClient.getStreams as jest.Mock).mockResolvedValue([
      { id: 's1', total_amount: '100', released_amount: '50', status: 'ACTIVE', recipient_address: 'addr1' }
    ]);
    (onChainClient.fetchStream as jest.Mock).mockResolvedValue({
      id: 's1', total_amount: 100n, released_amount: 50n, status: ContractStreamStatus.ACTIVE, recipient_address: 'addr2'
    });
    
    const report = await service.runReconciliation();
    
    expect(report.status).toBe('MISMATCH_FOUND');
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toMatchObject({
      streamId: 's1',
      field: 'recipient_address',
      dbValue: 'addr1',
      onChainValue: 'addr2'
    });
  });
});

describe('ReconciliationService abort signal', () => {
  let service: ReconciliationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ReconciliationService();
  });

  const dbStream = (id: string) => ({
    id, recipient_address: 'r', total_amount: '100', released_amount: '50',
    status: 'ACTIVE', last_sync_ledger: 0,
  });

  it('stops before checking provided streams when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const report = await service.runReconciliation({
      dbStreams: [dbStream('s1')],
      dryRun: true,
      signal: controller.signal,
    });

    expect(report.totalStreamsChecked).toBe(0);
    expect(report.status).toBe('FAILED');
    expect(report.errors[0].error).toContain('aborted');
    expect(onChainClient.fetchStream).not.toHaveBeenCalled();
  });

  it('stops mid-loop over provided streams when the signal fires', async () => {
    const controller = new AbortController();
    (onChainClient.fetchStream as jest.Mock).mockImplementation(async (network, id) => {
      controller.abort();
      return { id: 's1', total_amount: 100n, released_amount: 50n, status: ContractStreamStatus.ACTIVE };
    });

    const report = await service.runReconciliation({
      dbStreams: [dbStream('s1'), dbStream('s2')],
      dryRun: true,
      signal: controller.signal,
    });

    expect(report.totalStreamsChecked).toBe(1);
    expect(report.status).toBe('FAILED');
    expect(onChainClient.fetchStream).toHaveBeenCalledTimes(1);
  });

  it('stops before paginating when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const report = await service.runReconciliation({ dryRun: true, signal: controller.signal });

    expect(report.totalStreamsChecked).toBe(0);
    expect(report.status).toBe('FAILED');
    expect(dbClient.getStreams).not.toHaveBeenCalled();
  });

  it('stops mid-page in the paginated path when the signal fires', async () => {
    const controller = new AbortController();
    (dbClient.getStreams as jest.Mock).mockResolvedValue([dbStream('s1'), dbStream('s2')]);
    (onChainClient.fetchStream as jest.Mock).mockImplementation(async (network, id) => {
      controller.abort();
      return { id: 's1', total_amount: 100n, released_amount: 50n, status: ContractStreamStatus.ACTIVE };
    });

    const report = await service.runReconciliation({ dryRun: true, signal: controller.signal });

    expect(report.totalStreamsChecked).toBe(1);
    expect(report.status).toBe('FAILED');
    expect(onChainClient.fetchStream).toHaveBeenCalledTimes(1);
  });

  it('skips the last-run-status write when aborted, and writes it otherwise', async () => {
    const controller = new AbortController();
    (onChainClient.fetchStream as jest.Mock).mockImplementation(async (network, id) => {
      controller.abort();
      return { id: 's1', total_amount: 100n, released_amount: 50n, status: ContractStreamStatus.ACTIVE };
    });

    await service.runReconciliation({
      dbStreams: [dbStream('s1'), dbStream('s2')],
      dryRun: false,
      signal: controller.signal,
    });
    expect(dbClient.updateLastRunStatus).not.toHaveBeenCalled();

    jest.clearAllMocks();
    (onChainClient.fetchStream as jest.Mock).mockResolvedValue({
      id: 's1', total_amount: 100n, released_amount: 50n, status: ContractStreamStatus.ACTIVE,
    });
    await service.runReconciliation({ dbStreams: [dbStream('s1')], dryRun: false });
    expect(dbClient.updateLastRunStatus).toHaveBeenCalledTimes(1);
  });
});

describe('ReconciliationService kind-aware reporting', () => {
  let service: ReconciliationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ReconciliationService();
  });

  it('omits byKind and kind on standard-only runs for backward compatibility', async () => {
    (onChainClient.fetchStream as jest.Mock).mockResolvedValue({
      id: 's1',
      recipient_address: 'r1',
      total_amount: 200n,
      released_amount: 50n,
      status: ContractStreamStatus.ACTIVE,
    });

    const report = await service.runReconciliation({
      dbStreams: [
        {
          id: 's1',
          recipient_address: 'r1',
          total_amount: '100',
          released_amount: '50',
          status: 'ACTIVE',
          last_sync_ledger: 0,
        },
      ],
      dryRun: true,
    });

    expect(report.status).toBe('MISMATCH_FOUND');
    expect(report.byKind).toBeUndefined();
    expect('kind' in report.mismatches[0]).toBe(false);
  });

  it('reports per-kind counts and normalises split & recurring amounts using bigint math', async () => {
    (onChainClient.fetchStream as jest.Mock).mockImplementation(async (_net, id) => {
      if (id === 'std-1') {
        return {
          id: 'std-1',
          recipient_address: 'r1',
          total_amount: 100n,
          released_amount: 50n,
          status: ContractStreamStatus.ACTIVE,
        };
      }
      if (id === 'split-1') {
        return null; // missing on-chain
      }
      if (id === 'rec-1') {
        return {
          id: 'rec-1',
          recipient_address: 'r3',
          total_amount: 300000000000000000001n, // off by 1 stroop from 100000000000000000000 * 3
          released_amount: 0n,
          status: ContractStreamStatus.ACTIVE,
        };
      }
      return null;
    });

    const report = await service.runReconciliation({
      dbStreams: [
        {
          id: 'std-1',
          kind: 'standard',
          recipient_address: 'r1',
          total_amount: '100',
          released_amount: '50',
          status: 'ACTIVE',
          last_sync_ledger: 0,
        },
        {
          id: 'split-1',
          kind: 'split',
          recipient_address: 'r2',
          total_amount: '0',
          total: '500',
          released_amount: '0',
          status: 'ACTIVE',
          last_sync_ledger: 0,
        },
        {
          id: 'rec-1',
          kind: 'recurring',
          recipient_address: 'r3',
          total_amount: '0',
          amount_per_cycle: '100000000000000000000',
          total_cycles: 3,
          released_amount: '0',
          status: 'ACTIVE',
          last_sync_ledger: 0,
        },
      ],
      dryRun: true,
    });

    expect(report.status).toBe('MISMATCH_FOUND');
    expect(report.totalStreamsChecked).toBe(3);
    expect(report.byKind).toEqual({
      standard: { totalStreamsChecked: 1, mismatchCount: 0, errorCount: 0 },
      split: { totalStreamsChecked: 1, mismatchCount: 1, errorCount: 0 },
      recurring: { totalStreamsChecked: 1, mismatchCount: 1, errorCount: 0 },
    });
    expect(report.mismatches).toEqual([
      {
        streamId: 'split-1',
        kind: 'split',
        field: 'presence',
        dbValue: 'exists',
        onChainValue: 'missing',
        toleranceApplied: false,
      },
      {
        streamId: 'rec-1',
        kind: 'recurring',
        field: 'total_amount',
        dbValue: 300000000000000000000n,
        onChainValue: 300000000000000000001n,
        toleranceApplied: false,
      },
    ]);
  });
});
