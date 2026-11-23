import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countDiagnostics } from './typecheck-report.mjs';

test('counts diagnostics rather than continuation lines, across root and nested paths', () => {
  const output = [
    'lib/requestId.ts(1,7): error TS2322: Type is not assignable.',
    '  Further explanation, not another error.',
    'app/api/auth/wallet/route.ts(3,2): error TS2345: Bad argument.',
    'app\\lib\\config.ts(4,5): error TS2322: Bad value.',
    'middleware.ts(1,1): error TS2304: Missing name.',
    'error TS18003: No inputs were found.',
  ].join('\r\n');
  assert.deepEqual([...countDiagnostics(output)], [['lib', 1], ['app', 2], ['(root)', 1], ['(config)', 1]]);
});

test('a clean compiler run reports zero diagnostics', () => {
  assert.equal(countDiagnostics('').size, 0);
});
