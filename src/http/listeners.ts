import type express from "express";

export type Server = ReturnType<express.Express["listen"]>;

export interface BoundListener {
  readonly server: Server;
  /** Actual bound address; the port differs from the configured one for port 0. */
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Bind one listener and resolve with the actual address once accepting. */
export function listen(app: express.Express, host: string, port: number): Promise<BoundListener> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    const server = app.listen(port, host, () => {
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

/** Stop accepting and wait for the server to close; idle keep-alives do not block it. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

