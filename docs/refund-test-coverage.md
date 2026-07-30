# Refund Splitting Test Coverage

## Overview

This document describes the test coverage for the `cancel_stream` entrypoint's refund splitting logic. The tests verify that when a stream is cancelled, funds are correctly split between the sender and recipient based on the vested amount at cancellation time.

## Refund Logic

When a stream is cancelled, funds are split as follows:

- **Recipient** receives: `vested_amount - released_amount` (accrued but not yet withdrawn)
- **Sender** receives: `total_amount - vested_amount` (unvested/unstreamed)

This ensures the recipient is entitled to everything that has already vested, regardless of whether they have withdrawn it.

## Test File Location

`contracts/contracts/streampay-stream/tests/refund.rs`

## Test Coverage

### Boundary Conditions

#### 1. Cancel Immediately (0 vested)
- **Test**: `cancel_immediately_refunds_all_to_sender`
- **Scenario**: Stream cancelled before start_time
- **Expected**: Full amount refunded to sender, recipient receives nothing
- **Coverage**: Verifies zero vested amount handling

#### 2. Cancel After Full Vesting
- **Test**: `cancel_after_full_vesting_pays_all_to_recipient`
- **Scenario**: Stream cancelled after end_time (fully vested)
- **Expected**: Full amount paid to recipient, sender receives nothing
- **Coverage**: Verifies 100% vested amount handling

#### 3. Cancel with Partial Vesting (No Withdrawals)
- **Test**: `cancel_with_partial_vesting_splits_correctly`
- **Scenario**: Stream cancelled at 50% vested, no withdrawals made
- **Expected**: 50% to recipient, 50% to sender
- **Coverage**: Verifies proportional split at intermediate point

#### 4. Cancel with Partial Withdrawals
- **Test**: `cancel_with_withdrawals_pays_vested_minus_released`
- **Scenario**: Stream cancelled at 50% vested, 200k already withdrawn
- **Expected**: Recipient gets 300k (vested - released), sender gets 500k (unvested)
- **Coverage**: Verifies vested minus released calculation

#### 5. Cancel After Full Withdrawal
- **Test**: `cancel_after_full_withdrawal_refunds_nothing`
- **Scenario**: Stream cancelled after full amount withdrawn
- **Expected**: Neither party receives additional funds
- **Coverage**: Verifies no double-payment when fully withdrawn

#### 6. Cancel Paused Stream
- **Test**: `cancel_paused_stream_splits_correctly`
- **Scenario**: Stream paused at 1/3 vested, then cancelled
- **Expected**: Split based on vested amount at pause time
- **Coverage**: Verifies paused stream handling (accrual stops at pause)

#### 7. Cancel Draft Stream
- **Test**: `cancel_draft_stream_refunds_all_to_sender`
- **Scenario**: Stream cancelled before start_time (effectively draft)
- **Expected**: Full amount refunded to sender
- **Coverage**: Verifies pre-start cancellation handling

### Edge Cases

#### 8. Very Small Amounts
- **Test**: `cancel_with_small_amounts_handles_correctly`
- **Scenario**: Stream with total_amount = 1
- **Expected**: No arithmetic errors, correct split
- **Coverage**: Verifies handling of minimum amounts

#### 9. Very Large Amounts
- **Test**: `cancel_with_large_amounts_no_overflow`
- **Scenario**: Stream with total_amount = i128::MAX / 2
- **Expected**: No overflow, correct split
- **Coverage**: Verifies overflow-safe arithmetic

#### 10. Multiple Withdrawals Before Cancel
- **Test**: `cancel_with_multiple_withdrawals`
- **Scenario**: Two withdrawals before cancellation
- **Expected**: Correct calculation of remaining vested amount
- **Coverage**: Verifies cumulative released amount handling

#### 11. Cancel at Exact Boundaries
- **Test**: `cancel_at_start_time`
- **Scenario**: Cancel exactly at start_time
- **Expected**: 0 vested, full refund to sender
- **Coverage**: Verifies boundary condition at start

- **Test**: `cancel_at_end_time`
- **Scenario**: Cancel exactly at end_time
- **Expected**: Fully vested, full payout to recipient
- **Coverage**: Verifies boundary condition at end

### Error Cases

#### 12. Cancel Already Settled
- **Test**: `cancel_already_settled_fails`
- **Scenario**: Attempt to cancel a settled stream
- **Expected**: Operation fails with error
- **Coverage**: Verifies state transition guard

#### 13. Cancel Already Cancelled
- **Test**: `cancel_already_cancelled_fails`
- **Scenario**: Attempt to cancel an already cancelled stream
- **Expected**: Operation fails with error
- **Coverage**: Verifies idempotency guard

#### 14. Cancel Nonexistent Stream
- **Test**: `cancel_nonexistent_stream_fails`
- **Scenario**: Attempt to cancel non-existent stream_id
- **Expected**: Operation fails with error
- **Coverage**: Verifies existence check

## Test Statistics

- **Total Tests**: 14
- **Boundary Condition Tests**: 7
- **Edge Case Tests**: 5
- **Error Case Tests**: 3

## Coverage Goals

The test suite aims to achieve:

- **Line Coverage**: >95% of `cancel_stream` implementation
- **Branch Coverage**: All arithmetic branches (vested calculation, refund split)
- **State Coverage**: All stream states (Active, Paused, Draft, Settled, Cancelled)
- **Boundary Coverage**: 0%, 50%, 100% vested amounts
- **Error Coverage**: All error paths in `cancel_stream`

## Running Tests

```bash
cd contracts/contracts/streampay-stream
cargo test refund
```

## Test Utilities

The test suite provides helper functions:

- `setup_refund_test()`: Sets up test environment with deployed contract and funded sender
- `create_stream()`: Creates a stream with given parameters
- `get_balance()`: Gets token balance of an address

## Test Data Structure

```rust
struct RefundTestData {
    env: Env,
    admin: Address,
    sender: Address,
    recipient: Address,
    token: Address,
    client: ContractClient<'static>,
}
```

## Verification Approach

Each test verifies the refund split by:

1. Recording balances before cancellation
2. Executing `cancel_stream`
3. Recording balances after cancellation
4. Asserting expected payout amounts
5. Verifying stream status is `Cancelled`

## Known Limitations

1. **Paused Duration**: Tests do not cover resume after pause followed by cancel
2. **Amend + Cancel**: Tests do not cover stream amendment followed by cancellation
3. **Concurrent Operations**: Tests do not cover concurrent withdrawals and cancellation
4. **Multiple Streams**: Tests focus on single-stream scenarios

## Future Enhancements

Potential additional test coverage:

1. **Resume After Pause**: Cancel after pause → resume → cancel
2. **Amend Then Cancel**: Cancel after stream amendment
3. **Extreme Durations**: Very short (1 second) and very long (years) streams
4. **Token Precision**: Test with tokens having different decimal precisions
5. **Gas Measurement**: Measure gas cost of cancel operations

## Related Documentation

- [Stream Contract Documentation](contracts/contracts/streampay-stream/README.md)
- [Cancel Stream Implementation](contracts/contracts/streampay-stream/src/lib.rs)
- [Release Module](contracts/contracts/streampay-stream/src/release.rs)
