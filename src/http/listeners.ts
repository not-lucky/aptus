/**
 * @fileoverview Binding and graceful termination of Express applications on TCP sockets.
 *
 * Manages HTTP listener lifecycles for both the unauthenticated operations server
 * (`/health`, `/metrics`) and the authenticated client gateway server. Captures actual
 * bound addresses/ports and provides idle keep-alive severance during socket close.
 */

import type express from "express";

/**
 * Underlying Node.js HTTP server instance returned by `app.listen`.
 */
export type Server = ReturnType<express.Express["listen"]>;

/**
 * Handle representing an active bound HTTP listener.
 */
export interface BoundListener {
  /** Underlying Node.js HTTP server instance. */
  readonly server: Server;
  /** Actual bound IP address reported by the operating system. */
  readonly host: string;
  /** Actual bound TCP port (resolved from ephemeral port 0 if requested). */
  readonly port: number;
  /**
   * Idempotently closes the server, severing idle keep-alive connections to avoid hanging.
   *
   * @returns Promise resolving when the underlying TCP socket is released.
   */
  close(): Promise<void>;
}

/**
 * Binds an Express application to a host and port, resolving when listening starts.
 *
 * @param app - Express application to mount.
 * @param host - Interface host address (e.g. `127.0.0.1` or `0.0.0.0`).
 * @param port - TCP port number (0 indicates an ephemeral port).
 * @returns Promise resolving to the {@link BoundListener} handle.
 * @throws Error if socket binding fails or address cannot be read.
 */
export function listen(app: express.Express, host: string, port: number): Promise<BoundListener> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    const server = app.listen(port, host, (error?: unknown) => {
      if (error !== undefined) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error(`listener on ${host}:${port} reported no TCP address`));
        return;
      }
      resolve({
        server,
        host: address.address,
        port: address.port,
        close: () => closeServer(server),
      });
    });
    server.once("error", onError);
  });
}

/**
 * Closes an active server, severing idle keep-alives so closing does not hang.
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // Sever idle keep-alives immediately so the close callback fires without waiting for socket timeouts.
    server.closeIdleConnections();
  });
}
