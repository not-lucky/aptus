import type express from "express";

/**
 * Underlying Node HTTP Server instance returned by Express listen.
 */
export type Server = ReturnType<express.Express["listen"]>;

/**
 * An active, bound HTTP network listener.
 */
export interface BoundListener {
  /** Underlying Node HTTP Server instance. */
  readonly server: Server;
  /** Actual bound IP address (e.g. `"127.0.0.1"` or `"0.0.0.0"`). */
  readonly host: string;
  /** Actual bound TCP port number (resolved when configured port is `0`). */
  readonly port: number;
  /** Gracefully stops accepting new connections and closes the server. */
  close(): Promise<void>;
}

/**
 * Binds an Express application to the specified host and TCP port.
 *
 * @param app - Express application instance to bind.
 * @param host - Host interface IP or hostname to bind on.
 * @param port - TCP port number (0 for ephemeral OS-allocated port).
 * @returns Promise resolving to a {@link BoundListener} once the socket is actively listening.
 * @throws Error if socket binding fails or address cannot be determined.
 */
export function listen(app: express.Express, host: string, port: number): Promise<BoundListener> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    const server = app.listen(port, host, (error?: unknown) => {
      // Express 5 wires the listen callback as a one-time `error` listener in
      // addition to the `listening` path, so a bind failure (e.g. EADDRINUSE)
      // invokes this callback with the error instead of rejecting the raw
      // event. Reject with the real error here: the server never bound, so
      // `server.address()` would be `null` and misreport the failure as a
      // "no TCP address" defect.
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
 * Closes an active server, ensuring idle HTTP keep-alive connections are severed
 * so the server close callback resolves without waiting for client keep-alive timeouts.
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // Sever idle keep-alive sockets immediately so server close doesn't hang.
    server.closeIdleConnections();
  });
}
