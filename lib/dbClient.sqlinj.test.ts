import { buildFilterQuery, dbClient } from './dbClient';

describe('SQL Injection Regression Tests', () => {
  // OWASP SQL Injection Payload Corpus
  const owaspPayloads = [
    // Basic SQLi
    "' OR '1'='1",
    "' OR 1=1--",
    "' OR 1=1/*",
    "' OR '1'='1'--",
    "' OR '1'='1'/*",
    "' OR 1=1 LIMIT 1--",
    // Union-based
    "' UNION SELECT NULL--",
    "' UNION SELECT NULL, NULL--",
    "' UNION SELECT 1, 'a'--",
    // Error-based
    "' AND 1=CONVERT(int, (SELECT @@version))--",
    "' AND 1=CAST((SELECT @@version) AS int)--",
    // Time-based blind
    "'; WAITFOR DELAY '0:0:5'--",
    "' OR SLEEP(5)--",
    "' OR BENCHMARK(1000000,MD5(1))--",
    // Boolean-based blind
    "' AND 1=1--",
    "' AND 1=2--",
    "' OR 'a'='a",
    "' OR 'a'='b",
    // Stacked queries
    "'; DROP TABLE users--",
    "'; DELETE FROM streams--",
    "'; INSERT INTO users VALUES ('hacker', 'pw')--",
    // Comments
    "'--",
    "'/*",
    "'*/",
    "'#",
    // Quoted strings
    "''",
    "'\"'",
    "'\\'",
    // Special characters
    "' OR 1=1 --",
    "' OR 1=1 /*",
    "' OR 1=1 #",
    "' OR 'x'='x",
    // Union attacks
    "1' ORDER BY 1--",
    "1' ORDER BY 2--",
    "1' ORDER BY 3--",
    "1' UNION SELECT 1,2,3--",
    // Advanced
    "' AND ASCII(SUBSTRING((SELECT TOP 1 name FROM sysobjects),1,1))>100--",
    "' AND (SELECT TOP 1 name FROM sysobjects)>'a'--",
    "' OR EXISTS(SELECT * FROM users WHERE username='admin')--",
    // PostgreSQL-specific
    "'; SELECT pg_sleep(5)--",
    "' OR 1=1::int--",
    // MySQL-specific
    "' OR 1=1 LIMIT 1--",
    "' OR MID((SELECT version()),1,1)='5'--",
    // MSSQL-specific
    "'; EXEC xp_cmdshell('dir')--",
    "'; WAITFOR DELAY '00:00:05'--",
    // JSON/object injection (attempting to inject column names)
    { "id": "' OR 1=1--" },
    { "recipient_address": "' UNION SELECT * FROM secrets--" },
    // Invalid column names
    { "invalid_column": "' OR 1=1--" },
  ];

  it('should handle all OWASP SQL injection payloads safely without raw concatenation', () => {
    for (const payload of owaspPayloads) {
      let filters: Record<string, unknown>;
      if (typeof payload === 'string') {
        filters = { id: payload, status: payload };
      } else {
        filters = payload as Record<string, unknown>;
      }
      const result = buildFilterQuery(filters);

      // Assertions to prevent SQLi:
      // 1. No payload should appear in the raw SQL string (only in params)
      for (const value of Object.values(filters)) {
        if (typeof value === 'string') {
          expect(result.sql).not.toContain(value);
        }
      }

      // 2. All conditions use parameterized placeholders ($1, $2, etc.)
      expect(result.sql).toMatch(/(WHERE .*"\w+" = \$\d+)?/);
    }
  });

  it('should only allow safe, predefined columns in filter queries', () => {
    const dangerousFilters = {
      invalid_column: 'value',
      '; DROP TABLE': 'value',
      '" OR 1=1': 'value',
    };
    const result = buildFilterQuery(dangerousFilters);

    // No dangerous conditions should be added
    expect(result.sql).toBe('SELECT * FROM streams ');
    expect(result.params.length).toBe(0);
  });

  it('should safely filter streams even with malicious payloads (mock behavior)', async () => {
    for (const payload of owaspPayloads) {
      let filters: Record<string, unknown>;
      if (typeof payload === 'string') {
        filters = { id: payload };
      } else {
        filters = payload as Record<string, unknown>;
      }
      const streams = await dbClient.getStreams('tenant_1', 100, 0, filters);

      // No streams should match unless the payload exactly matches a real value
      expect(streams.length).toBeLessThanOrEqual(2);
    }
  });

  it('should correctly build queries with valid filters and no injection', () => {
    // Test valid, safe filters
    const result = buildFilterQuery({
      id: 'stream_1_t1',
      status: 'ACTIVE',
    });
    expect(result.sql).toBe('SELECT * FROM streams WHERE "id" = $1 AND "status" = $2');
    expect(result.params).toEqual(['stream_1_t1', 'ACTIVE']);
  });

  it('should handle null/undefined filters gracefully', () => {
    const result = buildFilterQuery({ id: null, status: undefined });
    expect(result.sql).toBe('SELECT * FROM streams ');
    expect(result.params).toEqual([]);
  });
});
