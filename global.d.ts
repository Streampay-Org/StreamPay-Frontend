/**
 * Ambient environment variable declarations.
 *
 * Documenting every supported env var here gives editor autocompletion
 * and a single grep target for config audits. Keep this in sync with
 * `.env.example`.
 */
declare namespace NodeJS {
  interface ProcessEnv {
    // -------------------------------------------------------------------------
    // 1. Required Core Configuration
    // -------------------------------------------------------------------------

    /** Stellar network selection. Required at boot ('testnet' | 'mainnet' | 'future'). */
    STELLAR_NETWORK?: 'testnet' | 'mainnet' | 'future';
    /** JWT signing secret. Must be 32+ chars in production. Required at boot. */
    JWT_SECRET?: string;
    /** Comma-separated CORS allowlist for public API routes. Required at boot. */
    ALLOWED_ORIGINS?: string;
    /** Node runtime mode ('development' | 'production' | 'test'). */
    NODE_ENV?: string;

    // -------------------------------------------------------------------------
    // 2. Application & Service Metadata
    // -------------------------------------------------------------------------

    /** Service name used in structured logs and distributed traces. */
    SERVICE_NAME?: string;
    /** Server execution runtime environment ('nodejs' | 'edge') set by Next.js. */
    NEXT_RUNTIME?: 'nodejs' | 'edge';

    // -------------------------------------------------------------------------
    // 3. Stellar & Soroban RPC Configuration
    // -------------------------------------------------------------------------

    /** Custom Stellar Horizon API endpoint override. */
    HORIZON_URL?: string;
    /** Soroban JSON-RPC endpoint for smart contract interactions and health checks. */
    SOROBAN_RPC_URL?: string;
    /** Minimum number of ledger confirmations before considering a withdrawal final. */
    WITHDRAWAL_MIN_CONFIRMATION_DEPTH?: string;
    /** Comma-separated list of additional allowed token asset identifiers (CODE:ISSUER). */
    ALLOWED_TOKENS?: string;

    // -------------------------------------------------------------------------
    // 4. Stellar Fee-Bump Sponsorship Service
    // -------------------------------------------------------------------------

    /** Stellar secret key (starts with 'S') of sponsor account paying transaction fees. */
    FEE_BUMP_SECRET_KEY?: string;
    /** Maximum allowable fee in stroops that the fee-bump sponsor will cover. */
    FEE_BUMP_MAX_FEE?: string;

    // -------------------------------------------------------------------------
    // 5. Key Management Service (KMS) & Signing
    // -------------------------------------------------------------------------

    /** KMS provider selection ('local-mock' | 'aws-kms'). */
    KMS_PROVIDER?: 'local-mock' | 'aws-kms';
    /** AWS KMS key ID or ARN (required when KMS_PROVIDER is 'aws-kms'). */
    KMS_KEY_ID?: string;
    /** AWS region for KMS API calls (default 'us-east-1'). */
    KMS_REGION?: string;
    /** Deterministic mock secret key used by local-mock KMS provider. */
    STELLAR_MOCK_SECRET?: string;

    // -------------------------------------------------------------------------
    // 6. Authentication, Key Rotation & Admin Security
    // -------------------------------------------------------------------------

    /** Active JWT Key ID (kid) included in JWT headers for key rotation. */
    JWT_KEY_ID?: string;
    /** Previous JWT Key ID (kid) accepted during rotation grace periods. */
    JWT_PREVIOUS_KEY_ID?: string;
    /** Previous JWT secret used to verify tokens issued prior to key rotation. */
    JWT_PREVIOUS_SECRET?: string;
    /** Emergency override flag allowing default dev JWT secret in production. */
    ALLOW_INSECURE_DEV_SECRET?: string;
    /** Stellar public address authorized for administrative operations. */
    STREAMPAY_ADMIN_ADDRESS?: string;

    // -------------------------------------------------------------------------
    // 7. Internal Service Authentication & HMAC
    // -------------------------------------------------------------------------

    /** Deprecated shared token for service-to-service auth (rejected in production). */
    INTERNAL_AUTH_TOKEN?: string;
    /** JSON map of HMAC key IDs to shared secrets for internal service signing. */
    INTERNAL_SERVICE_HMAC_KEYS?: string;
    /** Active key ID in INTERNAL_SERVICE_HMAC_KEYS used for signing internal requests. */
    INTERNAL_SERVICE_CURRENT_KEY_ID?: string;
    /** Allowed request freshness window / clock skew in seconds for HMAC auth. */
    INTERNAL_SERVICE_CLOCK_SKEW_SECONDS?: string;

    // -------------------------------------------------------------------------
    // 8. Webhooks Configuration
    // -------------------------------------------------------------------------

    /** Shared HMAC secret for verifying incoming and signing outgoing webhooks. */
    WEBHOOK_SECRET?: string;
    /** Per-user request rate limit for /api/webhooks routes. */
    WEBHOOK_RATE_LIMIT?: string;

    // -------------------------------------------------------------------------
    // 9. Database & Persistence
    // -------------------------------------------------------------------------

    /** PostgreSQL connection string URI for exports persistence and DB health checks. */
    DATABASE_URL?: string;

    // -------------------------------------------------------------------------
    // 10. Reconciliation Engine
    // -------------------------------------------------------------------------

    /** Bearer secret authorizing nightly reconciliation cron job requests. */
    RECON_CRON_SECRET?: string;
    /** Per-request deadline in milliseconds for stream reconciliation processing. */
    RECONCILIATION_TIMEOUT_MS?: string;
    /** Allowable stroop variance between ledger state and database balance. */
    RECONCILE_TOLERANCE?: string;
    /** Per-user request rate limit for public reconciliation endpoints. */
    RECONCILIATION_RATE_LIMIT?: string;
    /** Override flag for reconciliation database readiness health checks. */
    RECONCILIATION_DB_READY?: string;
    /** Override flag for reconciliation RPC readiness health checks. */
    RECONCILIATION_RPC_READY?: string;

    // -------------------------------------------------------------------------
    // 11. Rate Limiting & Quotas
    // -------------------------------------------------------------------------

    /** Rate limit storage backend type ('in-memory' | 'redis'). */
    RATE_LIMIT_STORE_TYPE?: 'in-memory' | 'redis';
    /** Maximum stream creation operations per organization per UTC day. */
    ORG_DAILY_STREAM_QUOTA_LIMIT?: string;

    // -------------------------------------------------------------------------
    // 12. Request Body Size Limits & Timeouts
    // -------------------------------------------------------------------------

    /** Maximum request body size cap in bytes for API routes (/api/* except webhooks). */
    MAX_STREAM_BODY_BYTES?: string;
    /** Maximum request body size cap in bytes for webhook routes (/api/webhooks*). */
    MAX_WEBHOOK_BODY_BYTES?: string;
    /** General fallback per-request timeout in milliseconds for API routes. */
    ROUTE_TIMEOUT_MS?: string;
    /** Per-request timeout in milliseconds for /api/v2/streams* routes. */
    STREAMS_TIMEOUT_MS?: string;
    /** Per-request timeout in milliseconds for GET /api/auth/wallet. */
    AUTH_WALLET_TIMEOUT_MS?: string;
    /** Per-request timeout in milliseconds for POST /api/auth/wallet. */
    AUTH_WALLET_VERIFY_TIMEOUT_MS?: string;
    /** Per-request timeout in milliseconds for /api/exports stream downloads. */
    EXPORTS_TIMEOUT_MS?: string;

    // -------------------------------------------------------------------------
    // 13. Server-Sent Events (SSE) & Indexer
    // -------------------------------------------------------------------------

    /** Milliseconds between keep-alive heartbeat comment frames in SSE streams. */
    SSE_HEARTBEAT_INTERVAL_MS?: string;
    /** Maximum heartbeat frames before terminating an SSE connection. */
    SSE_HEARTBEAT_MAX?: string;
    /** Maximum milliseconds of silence without write before closing dead SSE connections. */
    SSE_MAX_IDLE_MS?: string;
    /** Polling interval in milliseconds for indexer status SSE producer. */
    SSE_INTERVAL_MS?: string;
    /** Maximum data frames emitted per SSE connection before server closes stream. */
    SSE_MAX_EVENTS?: string;
    /** Bounded queue capacity for SSE event buffering. */
    SSE_QUEUE_CAPACITY?: string;
    /** Overflow policy when SSE queue exceeds capacity ('drop' | 'newest' | 'error'). */
    SSE_QUEUE_POLICY?: 'drop' | 'newest' | 'error';
    /** Duration in ms without ledger advancement before indexer is flagged as stalled. */
    STALL_THRESHOLD_MS?: string;

    // -------------------------------------------------------------------------
    // 14. Fraud & Anomaly Detection
    // -------------------------------------------------------------------------

    /** Override for the stream-creation burst anomaly threshold. */
    ANOMALY_CREATION_THRESHOLD?: string;
    /** Override for the settle-rate spike anomaly threshold. */
    ANOMALY_SETTLE_THRESHOLD?: string;
    /** Override for the stream-cancellation burst anomaly threshold. */
    ANOMALY_CANCEL_THRESHOLD?: string;

    // -------------------------------------------------------------------------
    // 15. Telemetry, Metrics & Observability
    // -------------------------------------------------------------------------

    /** Bearer token required to scrape Prometheus metrics from GET /api/metrics. */
    METRICS_AUTH_TOKEN?: string;
    /** OpenTelemetry OTLP collector endpoint URL. */
    OTEL_EXPORTER_OTLP_ENDPOINT?: string;
    /** Telemetry opt-in consent flag ('granted' | 'denied'). */
    STREAMPAY_TELEMETRY_CONSENT?: 'granted' | 'denied' | string;

    // -------------------------------------------------------------------------
    // 16. Routing, Canary & Feature Flags
    // -------------------------------------------------------------------------

    /** Percentage of requests sampled into canary routing (0-100). */
    CANARY_PERCENTAGE?: string;
    /** Client-side UI flag to disable on-chain actions in read-only mode ('true' | 'false'). */
    NEXT_PUBLIC_DISABLE_ONCHAIN_OPERATIONS?: string;
    /** Disable in-memory caching across queries and balances ('true' | 'false'). */
    STREAMPAY_CACHE_DISABLED?: string;
    /** Maximum concurrent active jobs handled simultaneously per queue. */
    QUEUE_MAX_ACTIVE_JOBS?: string;

    // -------------------------------------------------------------------------
    // 17. Chaos & Resilience Testing (Non-production only)
    // -------------------------------------------------------------------------

    /** Whether chaos fault injection is active ('true' | 'false'). */
    CHAOS_ENABLED?: string;
    /** Maximum simulated delay injected into requests in milliseconds. */
    CHAOS_LATENCY_MS?: string;
    /** Probability in [0, 1] of injecting a synthetic error response into requests. */
    CHAOS_ERROR_RATE?: string;
    /** HTTP status code returned when a chaos error is injected. */
    CHAOS_ERROR_STATUS?: string;

    // -------------------------------------------------------------------------
    // 18. Testing & CI Environments
    // -------------------------------------------------------------------------

    /** Set by CI providers. Triggers CI testnet guardrails. */
    CI?: string;
    /** Set by GitHub Actions runner. */
    GITHUB_ACTIONS?: string;
    /** Enables test-only code paths. Never set in production. */
    TEST_MODE?: string;
  }
}

declare global {
  /**
   * Process-wide cached configuration computed at boot.
   *
   * Modules should prefer reading from this object instead of touching
   * `process.env` directly so that hot-reload semantics stay predictable.
   */
  var streampayConfig: {
    /** Selected Stellar network profile (Horizon URL, passphrase, etc). */
    network: any;
    /** Resolved JWT signing secret. */
    jwtSecret: string;
    /** Logical service name used in logs and traces. */
    serviceName: string;
    /** Resolved NODE_ENV. */
    environment: string;
    /** Internal service-to-service bearer token, if configured. */
    internalAuthToken?: string;
    /** Resolved anomaly detector thresholds. */
    anomalyThresholds: {
      creationBurstLimit: number;
      settleRateLimit: number;
      cancelBurstLimit: number;
    };
  } | undefined;
}

declare module '*.css' {
  const content: Record<string, string>;
  export default content;
}

declare module '*.module.css' {
  const content: Record<string, string>;
  export default content;
}

export {};
