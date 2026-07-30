# CPU Instrumentation Documentation

## Overview

The CPU instrumentation module provides per-entrypoint CPU usage tracking for the StreamPay smart contract. It measures the number of CPU instructions consumed by each contract operation to help identify performance bottlenecks and optimize gas usage.

## Module Location

`contracts/contracts/streampay-stream/src/instrument.rs`

## Features

- **Per-entrypoint CPU tracking**: Records CPU instructions consumed by each contract entrypoint
- **Call counting**: Tracks how many times each entrypoint has been called
- **Statistics**: Maintains total CPU, average CPU per call, and maximum CPU per call
- **Overflow-safe**: Uses saturating arithmetic to prevent overflow errors
- **Persistent storage**: Metrics are stored in contract storage for historical analysis

## Data Structures

### CpuMetric

```rust
pub struct CpuMetric {
    pub entrypoint: Symbol,      // Name of the entrypoint
    pub total_cpu: u64,          // Total CPU instructions consumed
    pub call_count: u64,         // Number of calls
    pub max_cpu: u64,           // Maximum CPU in a single call
    pub last_updated: u64,       // Last updated timestamp
}
```

## Usage

### Basic Usage

Wrap entrypoint logic with `measure_cpu` to automatically record CPU usage:

```rust
use instrument::measure_cpu;
use soroban_sdk::symbol_short;

pub fn create_stream(env: Env, ...) -> Result<u64, Error> {
    let result = measure_cpu(&env, symbol_short!("create_stream"), || {
        // Entrypoint logic here
        create_stream_impl(env, sender, recipient, token, amount, start, end)
    });
    result
}
```

### Reading Metrics

Retrieve CPU metrics for a specific entrypoint:

```rust
use instrument::get_cpu_metric;
use soroban_sdk::symbol_short;

let metric = get_cpu_metric(&env, symbol_short!("create_stream"));
if let Some(m) = metric {
    println!("Total CPU: {}", m.total_cpu);
    println!("Call count: {}", m.call_count);
    println!("Average CPU: {}", m.total_cpu / m.call_count);
    println!("Max CPU: {}", m.max_cpu);
}
```

### Average CPU Calculation

Get the average CPU per call for an entrypoint:

```rust
use instrument::average_cpu_per_call;
use soroban_sdk::symbol_short;

let avg = average_cpu_per_call(&env, symbol_short!("withdraw"));
```

### Reset Metrics

Reset metrics for a specific entrypoint (useful for testing):

```rust
use instrument::reset_cpu_metric;
use soroban_sdk::symbol_short;

reset_cpu_metric(&env, symbol_short!("create_stream"));
```

## Storage Layout

CPU metrics are stored in persistent storage using the following keys:

- `InstrumentKey::CpuMetric(entrypoint)` - Per-entrypoint metrics
- `InstrumentKey::CpuMetricCount` - Number of tracked entrypoints

## Entrypoints to Instrument

The following entrypoints should be instrumented for CPU tracking:

### State-Changing Operations
- `create_stream` - Stream creation
- `create_stream_for_org` - Org-specific stream creation
- `start_stream` - Stream activation
- `withdraw` - Token withdrawal
- `pause` - Stream pause
- `resume` - Stream resume
- `cancel_stream` - Stream cancellation
- `settle` - Stream settlement

### Administrative Operations
- `initialize` - Contract initialization
- `init_with_token_allowlist` - Initialization with allowlist
- `set_paused` - Pause flag toggle
- `set_admin` - Admin transfer
- `set_token_allowed` - Token allowlist management
- `set_org_token_allowed` - Org token allowlist management
- `set_max_streams_per_sender` - Sender limit configuration

### Read-Only Operations
- `get_stream` - Stream retrieval
- `withdrawable` - Withdrawable amount calculation
- `stream_balance` - Stream balance calculation
- `is_org_token_allowed` - Token allowlist check
- `max_streams_per_sender` - Sender limit query
- `sender_stream_count` - Sender stream count
- `remaining_sender_capacity` - Remaining capacity query

## Integration Example

To integrate CPU instrumentation into an entrypoint:

```rust
use instrument::measure_cpu;
use soroban_sdk::symbol_short;

#[contractimpl]
impl Contract {
    pub fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token: Address,
        total_amount: i128,
        start_time: u64,
        end_time: u64,
    ) -> Result<u64, Error> {
        measure_cpu(&env, symbol_short!("create_stream"), || {
            // Existing entrypoint logic
            require_not_paused(&env)?;
            sender.require_auth();
            limits::check_sender_limit(&env, &sender)?;
            
            // ... rest of the implementation
        })
    }
}
```

## Testing

The module includes comprehensive unit tests:

```bash
cd contracts/contracts/streampay-stream
cargo test instrument
```

Test coverage includes:
- Basic CPU measurement
- Multiple call tracking
- Metric retrieval
- Average calculation
- Metric reset
- Maximum CPU tracking
- Overflow safety

## Performance Considerations

- **Overhead**: CPU measurement adds minimal overhead (2 CPU instructions for `cpu_instr_consumed` calls)
- **Storage**: Each tracked entrypoint adds one storage entry (~100 bytes)
- **Gas**: Storage writes for metrics consume additional gas
- **Recommendation**: Only instrument entrypoints that are called frequently or are performance-critical

## Security Considerations

- **No sensitive data**: CPU metrics do not contain sensitive information
- **Read-only**: Metrics are purely informational and do not affect contract logic
- **No auth required**: Reading metrics does not require authentication
- **Overflow-safe**: All arithmetic uses saturating operations to prevent overflow attacks

## Monitoring and Analysis

### Key Metrics to Monitor

1. **High CPU entrypoints**: Identify entrypoints with high average CPU per call
2. **Call frequency**: Track which entrypoints are called most frequently
3. **CPU spikes**: Monitor for unusual CPU consumption patterns
4. **Trends**: Track CPU usage over time to identify degradation

### Alerting Thresholds

Consider setting alerts for:
- Average CPU > 100,000 instructions per call
- Maximum CPU > 1,000,000 instructions per call
- Call count > 10,000 per day

## Troubleshooting

### Metrics Not Recording

If metrics are not being recorded:
1. Verify `measure_cpu` is called with correct entrypoint name
2. Check that the closure executes successfully
3. Ensure storage is not full

### Unexpected CPU Values

If CPU values seem incorrect:
1. Verify the entrypoint name is consistent across calls
2. Check for nested `measure_cpu` calls (avoid double-counting)
3. Ensure the Soroban environment is properly configured

### Storage Issues

If storage-related errors occur:
1. Check available storage capacity
2. Consider resetting old metrics
3. Reduce the number of instrumented entrypoints

## Future Enhancements

Potential improvements for CPU instrumentation:

1. **Percentile tracking**: Add p50, p95, p99 CPU metrics
2. **Time windows**: Track CPU usage over configurable time windows
3. **Aggregation**: Aggregate metrics by time period (hourly, daily)
4. **Export**: Add entrypoint to export metrics for external analysis
5. **Thresholds**: Add configurable CPU usage thresholds
6. **Automatic cleanup**: Automatically expire old metrics

## Related Documentation

- [Soroban CPU Instructions](https://soroban.stellar.org/docs/learn/execution-environment#cpu-instructions)
- [Contract Storage](https://soroban.stellar.org/docs/learn/storage)
- [Gas and Fees](https://soroban.stellar.org/docs/learn/fees)
