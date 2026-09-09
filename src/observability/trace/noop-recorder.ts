/**
 * @fileoverview No-operation trace recorder for deployments with tracing disabled.
 *
 * Provides a no-op implementation of {@link TraceRecorder} and {@link TraceSession}.
 * Used when tracing is disabled in configuration, allowing gateway and relay logic
 * to interact with trace recording unconditionally without performance overhead or disk I/O.
 *
 * Invariants: The returned session is completely stateless, re-used across requests,
 * and its methods always resolve immediately without throwing or allocating resources.
 */

import type { TraceRecorder, TraceSession } from "../../domain/contracts.ts";

/**
 * Creates a no-operation trace recorder that discards all trace events.
 *
 * Returns a shared, stateless {@link TraceRecorder} whose session methods resolve
 * immediately without performing I/O.
 *
 * @returns A stateless {@link TraceRecorder} instance.
 */
export function createNoopTraceRecorder(): TraceRecorder {
  /**
   * Shared stateless session returned for every traced request.
   */
  const session: TraceSession = {
    /**
     * Discards structured JSON stage data without writing.
     *
     * @returns Promise resolving immediately.
     */
    async recordJson(): Promise<void> {
      // Intentionally empty.
    },
    /**
     * Discards raw payload bytes without writing.
     *
     * @returns Promise resolving immediately.
     */
    async recordBytes(): Promise<void> {
      // Intentionally empty.
    },
    /**
     * Opens a no-operation byte sink for a streaming stage.
     *
     * @returns A byte sink whose operations resolve immediately without writing.
     */
    openBytes() {
      return {
        /**
         * Discards one streamed chunk without writing.
         *
         * @returns Promise resolving immediately.
         */
        async append(): Promise<void> {},
        /**
         * Finishes the no-operation stream sink.
         *
         * @returns Promise resolving immediately.
         */
        async complete(): Promise<void> {},
        /**
         * Abandons the no-operation stream sink.
         *
         * @returns Promise resolving immediately.
         */
        async discard(): Promise<void> {},
      };
    },
    /**
     * Finishes the session without writing a terminal marker.
     *
     * @returns Promise resolving immediately.
     */
    async finish(): Promise<void> {
      // Intentionally empty.
    },
  };

  return {
    /**
     * Opens the shared no-operation session for an admitted request.
     *
     * @returns Promise resolving to the shared {@link TraceSession}.
     */
    async start(): Promise<TraceSession> {
      return session;
    },
  };
}
