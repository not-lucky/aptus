import express from "express";

/** Options for constructing the client Express application. */
export type ClientAppOptions = {};

/**
 * The client listener. Release 1 mounts create endpoints and the local catalog
 * here in later phases; until then every path is a 404.
 */
export function createClientApp(_options?: ClientAppOptions): express.Express {
  const app = express();
  app.use((_req, res) => {
    res.status(404).end();
  });
  return app;
}
