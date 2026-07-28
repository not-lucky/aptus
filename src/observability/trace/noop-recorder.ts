import type { TraceRecorder, TraceSession } from "../../domain/contracts.ts";

/**
 * Creates a no-op {@link TraceRecorder} used when tracing is disabled.
 *
 * Every method resolves immediately; `start()` returns a shared session whose
 * record/finish calls are no-ops. This keeps the Gateway's trace-seam logic
 * identical regardless of the tracing configuration.
 *
 * @returns A {@link TraceRecorder} that records nothing.
 */
export function createNoopTraceRecorder(): TraceRecorder {
  const session: TraceSession = {
    async recordJson(): Promise<void> {
      // Intentionally empty.
    },
    async recordBytes(): Promise<void> {
      // Intentionally empty.
    },
    async finish(): Promise<void> {
      // Intentionally empty.
    },
  };

  return {
    async start(): Promise<TraceSession> {
      return session;
    },
  };
}
