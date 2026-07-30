import { DbStream } from '../scripts/reconciliation/types';

/**
 * DB Client for StreamPay.
 * Implements a dynamic filter clause builder using parameterized queries to prevent SQL injection.
 */

// New mock data structure for multi-tenancy
const mockDbData: Record<string, DbStream[]> = {
  "tenant_1": [
    {
      id: "stream_1_t1",
      recipient_address: "GDVLR...t1_123",
      total_amount: "1000000000",
      released_amount: "500000000",
      status: "ACTIVE",
      last_sync_ledger: 100,
    },
    {
      id: "stream_2_t1",
      recipient_address: "GDVLR...t1_456",
      total_amount: "2000000000",
      released_amount: "1000000000",
      status: "ACTIVE",
      last_sync_ledger: 101,
    }
  ],
  "tenant_2": [
    {
      id: "stream_1_t2",
      recipient_address: "GCABC...t2_789",
      total_amount: "500000000",
      released_amount: "100000000",
      status: "ACTIVE",
      last_sync_ledger: 200,
    },
  ]
};

/**
 * Safe, parameterized dynamic filter query builder.
 * All user inputs are passed as parameters, no raw concatenation allowed!
 */
export function buildFilterQuery(filters: Record<string, unknown>) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  // Define allowed filter columns to prevent column injection
  const allowedColumns = new Set([
    'id',
    'recipient_address',
    'status',
    'last_sync_ledger',
    'tenant_id',
  ]);

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    if (!allowedColumns.has(key)) continue; // Skip unrecognized columns

    conditions.push(`"${key}" = $${paramIndex}`);
    params.push(value);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return {
    sql: `SELECT * FROM streams ${whereClause}`,
    params,
  };
}

export const dbClient = {
  /**
   * Fetch a page of streams from the database for a specific tenant, optionally with filters.
   */
  async getStreams(
    ...args: [string | number, number?, number?, Record<string, unknown>?]
  ): Promise<DbStream[]> {
    let tenantId = "default";
    let limit = 100;
    let offset = 0;
    let filters: Record<string, unknown> = {};

    if (args.length === 4) {
      [tenantId, limit, offset, filters] = args as [string, number, number, Record<string, unknown>];
    } else if (args.length === 3) {
      // Check if 3rd argument is number (offset) or object (filters)
      if (typeof args[2] === 'number') {
        [tenantId, limit, offset] = args as [string, number, number];
      } else {
        [tenantId, limit, filters] = args as [string, number, Record<string, unknown>];
      }
    } else if (args.length === 2) {
      [limit, offset] = args as [number, number];
    } else if (args.length === 1) {
      [limit] = args as [number];
    }

    let streamsList = mockDbData[tenantId as keyof typeof mockDbData] || [];

    // Apply filters (simulating parameterized query behavior)
    if (Object.keys(filters).length > 0) {
      streamsList = streamsList.filter((stream) => {
        for (const [key, value] of Object.entries(filters)) {
          if (value === undefined || value === null) continue;
          // @ts-ignore - safe since we're mocking
          if (stream[key] !== value) {
            return false;
          }
        }
        return true;
      });
    }

    return streamsList.slice(offset, offset + limit);
  },

  /**
   * Fetch a single stream by ID for a specific tenant.
   */
  async getStreamById(...args: [string | number, string?]): Promise<DbStream | null> {
    let tenantId = "default";
    let id = "";

    if (args.length === 2) {
      [tenantId, id] = args as [string, string];
    } else {
      [id] = args as [string];
    }

    const streams = await this.getStreams(tenantId, 10000, 0, { id });
    return streams[0] || null;
  },

  /**
   * Update the last run status for a specific tenant.
   * In a real DB, this would write to a tenant-specific table or a table with a tenant_id column.
   */
  async updateLastRunStatus(...args: [string | number, string | number, number?]) {
    let tenantId = "default";
    let status = "UNKNOWN";
    let timestamp = Date.now();

    if (args.length === 3) {
      [tenantId, status, timestamp] = args as [string, string, number];
    } else if (args.length === 2) {
      [status, timestamp] = args as [string, number];
    }

    console.log(`[DB] Updated last run status to ${status}`);
  },
};

/** For testing purposes to reset state */
export function getMockData() {
  return mockDbData;
}
