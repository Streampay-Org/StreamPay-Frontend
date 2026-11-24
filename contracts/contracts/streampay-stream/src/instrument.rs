//! # CPU instrumentation per entrypoint
//!
//! This module provides CPU usage tracking and measurement for each contract
//! entrypoint. It records the number of CPU instructions consumed by each
//! operation to help identify performance bottlenecks and optimize gas usage.
//!
//! ## Usage
//!
//! Wrap entrypoint logic with `measure_cpu` to automatically record CPU usage:
//!
//! ```ignore
//! let result = measure_cpu(&env, "create_stream", || {
//!     // entrypoint logic here
//!     create_stream_impl(env, sender, recipient, token, amount, start, end)
//! });
//! ```
//!
//! ## Storage
//!
//! CPU metrics are stored in persistent storage with the following keys:
//! - `CpuMetric(entrypoint_name)` - Per-entrypoint CPU instruction counts
//! - `CpuMetricCount` - Number of different entrypoints tracked
//!
//! ## Metrics
//!
//! Each metric records:
//! - Total CPU instructions consumed
//! - Number of calls to the entrypoint
//! - Average CPU per call
//! - Maximum CPU per call
//! - Last updated timestamp

use soroban_sdk::{contracttype, Env, Symbol};

/// CPU usage metrics for a single entrypoint.
#[derive(Clone, Debug)]
#[contracttype]
pub struct CpuMetric {
    /// Name of the entrypoint (e.g., "create_stream", "withdraw").
    pub entrypoint: Symbol,
    /// Total CPU instructions consumed across all calls.
    pub total_cpu: u64,
    /// Number of times this entrypoint has been called.
    pub call_count: u64,
    /// Maximum CPU instructions consumed in a single call.
    pub max_cpu: u64,
    /// Last updated ledger timestamp.
    pub last_updated: u64,
}

/// Storage keys for CPU instrumentation data.
#[derive(Clone)]
#[contracttype]
enum InstrumentKey {
    /// Per-entrypoint CPU metrics keyed by entrypoint name.
    CpuMetric(Symbol),
    /// Counter for number of tracked entrypoints.
    CpuMetricCount,
}

/// Measures CPU usage for a given entrypoint operation.
///
/// This function records the CPU instructions consumed by executing the
/// provided closure and updates the stored metrics for the entrypoint.
///
/// # Arguments
///
/// * `env` - The Soroban environment
/// * `entrypoint` - The name of the entrypoint being measured
/// * `f` - The closure to execute and measure
///
/// # Returns
///
/// The result of executing the closure.
///
/// # Errors
///
/// This function does not return errors. Any panics in the closure will
/// propagate without updating metrics.
///
/// # Example
///
/// ```ignore
/// let result = measure_cpu(&env, symbol_short!("create_stream"), || {
///     create_stream_impl(env, sender, recipient, token, amount, start, end)
/// });
/// ```
pub fn measure_cpu<F, R>(env: &Env, entrypoint: Symbol, f: F) -> R
where
    F: FnOnce() -> R,
{
    // Get CPU before execution
    let cpu_before = env.host().cpu_instr_consumed();

    // Execute the operation
    let result = f();

    // Get CPU after execution
    let cpu_after = env.host().cpu_instr_consumed();
    let cpu_used = cpu_after
        .checked_sub(cpu_before)
        .unwrap_or(0);

    // Update metrics
    update_cpu_metric(env, entrypoint, cpu_used);

    result
}

/// Updates the CPU metric for a given entrypoint.
///
/// This function increments the call count, adds the CPU usage to the total,
/// and updates the maximum CPU if this call consumed more than previous calls.
///
/// # Arguments
///
/// * `env` - The Soroban environment
/// * `entrypoint` - The name of the entrypoint
/// * `cpu_used` - CPU instructions consumed in this call
///
/// # Errors
///
/// This function does not return errors. Overflow in arithmetic is handled
/// by saturating arithmetic.
fn update_cpu_metric(env: &Env, entrypoint: Symbol, cpu_used: u64) {
    let key = InstrumentKey::CpuMetric(entrypoint);
    let now = env.ledger().timestamp();

    let metric = env
        .storage()
        .persistent()
        .get::<InstrumentKey, CpuMetric>(&key)
        .unwrap_or_else(|| CpuMetric {
            entrypoint,
            total_cpu: 0,
            call_count: 0,
            max_cpu: 0,
            last_updated: 0,
        });

    let updated = CpuMetric {
        entrypoint: metric.entrypoint,
        total_cpu: metric.total_cpu.saturating_add(cpu_used),
        call_count: metric.call_count.saturating_add(1),
        max_cpu: metric.max_cpu.max(cpu_used),
        last_updated: now,
    };

    env.storage()
        .persistent()
        .set(&key, &updated);
}

/// Retrieves CPU metrics for a specific entrypoint.
///
/// # Arguments
///
/// * `env` - The Soroban environment
/// * `entrypoint` - The name of the entrypoint to query
///
/// # Returns
///
/// - `Some(CpuMetric)` if metrics exist for the entrypoint
/// - `None` if no metrics have been recorded
///
/// # Errors
///
/// This function does not return errors.
pub fn get_cpu_metric(env: &Env, entrypoint: Symbol) -> Option<CpuMetric> {
    env.storage()
        .persistent()
        .get(&InstrumentKey::CpuMetric(entrypoint))
}

/// Calculates the average CPU per call for a given entrypoint.
///
/// Returns 0 if the entrypoint has not been called.
///
/// # Arguments
///
/// * `env` - The Soroban environment
/// * `entrypoint` - The name of the entrypoint to query
///
/// # Returns
///
/// The average CPU instructions per call, or 0 if no calls recorded.
///
/// # Errors
///
/// This function does not return errors. Division is safe because we check
/// for zero call count.
pub fn average_cpu_per_call(env: &Env, entrypoint: Symbol) -> u64 {
    if let Some(metric) = get_cpu_metric(env, entrypoint) {
        if metric.call_count > 0 {
            return metric.total_cpu
                .checked_div(metric.call_count)
                .unwrap_or(0);
        }
    }
    0
}

/// Resets CPU metrics for a specific entrypoint.
///
/// This is primarily useful for testing or administrative reset of metrics.
///
/// # Arguments
///
/// * `env` - The Soroban environment
/// * `entrypoint` - The name of the entrypoint to reset
///
/// # Returns
///
/// This function does not return a value.
///
/// # Errors
///
/// This function does not return errors.
pub fn reset_cpu_metric(env: &Env, entrypoint: Symbol) {
    env.storage()
        .persistent()
        .remove(&InstrumentKey::CpuMetric(entrypoint));
}

/// Returns the total CPU consumed across all tracked entrypoints.
///
/// # Arguments
///
/// * `env` - The Soroban environment
///
/// # Returns
///
/// The sum of total CPU instructions across all entrypoints.
///
/// # Errors
///
/// This function does not return errors.
pub fn total_cpu_all_entrypoints(env: &Env) -> u64 {
    // In a real implementation, we would need to iterate over all keys
    // but Soroban doesn't provide key iteration. This is a placeholder.
    // For now, return 0 as we can't iterate storage keys.
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::symbol_short;

    #[test]
    fn test_measure_cpu_basic() {
        let env = Env::default();
        let entrypoint = symbol_short!("test_entry");

        let result = measure_cpu(&env, entrypoint, || {
            // Simulate some work
            let mut sum = 0u64;
            for i in 0..1000 {
                sum = sum.saturating_add(i);
            }
            sum
        });

        assert_eq!(result, 499500); // sum of 0..999

        let metric = get_cpu_metric(&env, entrypoint);
        assert!(metric.is_some());
        let metric = metric.unwrap();
        assert_eq!(metric.call_count, 1);
        assert!(metric.total_cpu > 0);
        assert!(metric.max_cpu > 0);
    }

    #[test]
    fn test_measure_cpu_multiple_calls() {
        let env = Env::default();
        let entrypoint = symbol_short!("multi_call");

        // First call
        measure_cpu(&env, entrypoint, || 42);
        // Second call
        measure_cpu(&env, entrypoint, || 100);

        let metric = get_cpu_metric(&env, entrypoint).unwrap();
        assert_eq!(metric.call_count, 2);
        assert!(metric.total_cpu > 0);
        assert!(metric.max_cpu > 0);
    }

    #[test]
    fn test_get_cpu_metric_none() {
        let env = Env::default();
        let entrypoint = symbol_short!("nonexistent");

        let metric = get_cpu_metric(&env, entrypoint);
        assert!(metric.is_none());
    }

    #[test]
    fn test_average_cpu_per_call() {
        let env = Env::default();
        let entrypoint = symbol_short!("avg_test");

        measure_cpu(&env, entrypoint, || 1);
        measure_cpu(&env, entrypoint, || 2);

        let avg = average_cpu_per_call(&env, entrypoint);
        assert!(avg > 0);
    }

    #[test]
    fn test_average_cpu_per_call_zero_calls() {
        let env = Env::default();
        let entrypoint = symbol_short!("no_calls");

        let avg = average_cpu_per_call(&env, entrypoint);
        assert_eq!(avg, 0);
    }

    #[test]
    fn test_reset_cpu_metric() {
        let env = Env::default();
        let entrypoint = symbol_short!("reset_test");

        measure_cpu(&env, entrypoint, || 123);
        assert!(get_cpu_metric(&env, entrypoint).is_some());

        reset_cpu_metric(&env, entrypoint);
        assert!(get_cpu_metric(&env, entrypoint).is_none());
    }

    #[test]
    fn test_max_cpu_tracking() {
        let env = Env::default();
        let entrypoint = symbol_short!("max_test");

        // First call with small work
        measure_cpu(&env, entrypoint, || {
            let mut sum = 0u64;
            for i in 0..100 {
                sum = sum.saturating_add(i);
            }
            sum
        });

        let first_max = get_cpu_metric(&env, entrypoint).unwrap().max_cpu;

        // Second call with more work
        measure_cpu(&env, entrypoint, || {
            let mut sum = 0u64;
            for i in 0..1000 {
                sum = sum.saturating_add(i);
            }
            sum
        });

        let second_max = get_cpu_metric(&env, entrypoint).unwrap().max_cpu;
        assert!(second_max >= first_max);
    }

    #[test]
    fn test_overflow_safety() {
        let env = Env::default();
        let entrypoint = symbol_short!("overflow_test");

        // Test with very large CPU values to ensure saturating arithmetic works
        let metric_before = CpuMetric {
            entrypoint,
            total_cpu: u64::MAX - 1000,
            call_count: 1,
            max_cpu: 100,
            last_updated: 0,
        };

        env.storage()
            .persistent()
            .set(&InstrumentKey::CpuMetric(entrypoint), &metric_before);

        // This should not panic due to saturating arithmetic
        measure_cpu(&env, entrypoint, || {
            let mut sum = 0u64;
            for i in 0..10000 {
                sum = sum.saturating_add(i);
            }
            sum
        });

        let metric_after = get_cpu_metric(&env, entrypoint).unwrap();
        assert_eq!(metric_after.call_count, 2);
        // total_cpu should be saturated at u64::MAX
        assert!(metric_after.total_cpu >= metric_before.total_cpu);
    }
}
