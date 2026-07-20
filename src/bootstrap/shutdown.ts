import type { Server } from "../http/listeners.js";

/**
 * Graceful shutdown: mark readiness false, stop
 * accepting on the client listener, drain for `shutdownDrainMs`, abort any
 * remaining connections, then close the operations listener. A second signal
 * aborts the drain immediately; the process still exits 0.
 */
export interface GracefulShutdown {
  run(): Promise<void>;
  abort(): void;
}

export function createGracefulShutdown(opts: {
  readonly client: Server;
  readonly operations: Server;
  readonly drainMs: number;
  readonly onDraining: () => void;
}): GracefulShutdown {
  let force: (() => void) | undefined;
  let started = false;

  const run = async (): Promise<void> => {
    if (started) {
      return;
    }
    started = true;
    opts.onDraining();
    const clientClosed = new Promise<void>((resolve) => {
      opts.client.close(() => resolve());
      opts.client.closeIdleConnections();
    });
    let timer: NodeJS.Timeout | undefined;
    let forced = false;
    const finish = (): void => {
      if (forced) {
        return;
      }
      forced = true;
      clearTimeout(timer);
      opts.client.closeAllConnections();
    };
    timer = setTimeout(finish, opts.drainMs);
    force = finish;
    await clientClosed;
    finish();
    await closeOperations(opts.operations);
  };

  return {
    run,
    abort: () => force?.(),
  };
}

function closeOperations(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}
