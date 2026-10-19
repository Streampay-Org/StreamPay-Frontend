/**
 * Next.js instrumentation hook.
 *
 * Next.js only loads `instrumentation.ts` from the project root (or `src/`).
 * The tracer is registered for the Node.js runtime only; edge runtimes do not
 * provide the APIs the OTLP exporter relies on.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./lib/otel');
  }
}
