/**
 * Shared recording telemetry observer for tests.
 *
 * The observer seam is a single `observe(moment)` channel, so a recording double is a
 * one-method object pushing every moment onto an events list. Assertions query the list
 * by moment type with {@link eventsOf}, keeping individual tests free of per-method fakes.
 */
import type { LifecycleEvent, LifecycleObserver } from "../../src/observability/lifecycle-observer.ts";

export interface TrackingObserver {
  /** Recording observer that appends every moment to `events`. */
  readonly observer: LifecycleObserver;
  /** Every telemetry moment observed, in emission order. */
  readonly events: LifecycleEvent[];
}

/**
 * Creates a recording {@link LifecycleObserver} plus the events it has observed.
 */
export function createTrackingObserver(): TrackingObserver {
  const events: LifecycleEvent[] = [];
  return {
    observer: {
      observe(event: LifecycleEvent): void {
        events.push(event);
      },
    },
    events,
  };
}

/**
 * Returns the moments of one type from an observed event list.
 *
 * @param events - Observed event list.
 * @param type - Moment type tag to filter by.
 * @returns The events of that type, in emission order.
 */
export function eventsOf<T extends LifecycleEvent["type"]>(
  events: LifecycleEvent[],
  type: T,
): Array<Extract<LifecycleEvent, { type: T }>> {
  return events.filter((event): event is Extract<LifecycleEvent, { type: T }> => event.type === type);
}
