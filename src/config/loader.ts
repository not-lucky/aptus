import * as yaml from "js-yaml";
import { GatewayConfigSchema } from "./schema.js";
import type { GatewayConfig } from "./schema.js";
import type { SecretResolverPort } from "../ports/index.js";

/** Options for validating configuration and consuming secrets after validation. */
export interface ConfigurationLoadOptions {
  /** Secret resolver owned by the infrastructure boundary. */
  readonly resolver: SecretResolverPort;
  /** Cancellation signal forwarded to every secret operation. */
  readonly signal: AbortSignal;
  /** Ephemeral handoff for one resolved secret; values are never retained by the loader. */
  readonly consumeSecret: (secret: {
    readonly scope: "client-token-hash" | "provider-credential";
    readonly ownerId: string;
    readonly reference: string;
    readonly value: string;
  }) => void | Promise<void>;
}

/** A safe configuration diagnostic containing only a path and validation message. */
export interface ConfigurationIssue {
  /** Location of the invalid configuration value. */
  readonly path: ReadonlyArray<PropertyKey>;
  /** Safe diagnostic text without secret values. */
  readonly message: string;
}

/** Startup configuration failure containing safe structural or lifecycle diagnostics. */
export class ConfigurationLoadError extends Error {
  /** Safe issues that caused loading to fail. */
  readonly issues: ReadonlyArray<ConfigurationIssue>;

  /** Creates a configuration load failure. */
  constructor(issues: ReadonlyArray<ConfigurationIssue>) {
    super("configuration load failed");
    this.name = "ConfigurationLoadError";
    this.issues = issues;
  }
}

function issue(
  path: ReadonlyArray<PropertyKey>,
  message: string,
): ConfigurationLoadError {
  return new ConfigurationLoadError([{ path, message }]);
}

/** Parses, validates, and then consumes referenced secrets without retaining their values. */
export async function loadConfiguration(
  yamlText: string,
  options: ConfigurationLoadOptions,
): Promise<GatewayConfig> {
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch {
    throw issue([], "malformed YAML");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw issue([], "configuration root must be an object");
  }

  const result = GatewayConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigurationLoadError(
      result.error.issues.map((diagnostic) => ({
        path: diagnostic.path,
        message: diagnostic.message,
      })),
    );
  }

  const config = result.data;
  for (const client of config.clients) {
    let value: string;
    try {
      value = await options.resolver.resolve(
        client.tokenHashRef,
        options.signal,
      );
    } catch {
      throw issue(
        ["clients", config.clients.indexOf(client), "tokenHashRef"],
        "secret resolution failed",
      );
    }
    try {
      await options.consumeSecret({
        scope: "client-token-hash",
        ownerId: client.id,
        reference: client.tokenHashRef,
        value,
      });
    } catch {
      throw issue(
        ["clients", config.clients.indexOf(client), "tokenHashRef"],
        "secret consumption failed",
      );
    }
  }
  for (const provider of config.providers) {
    for (const credential of provider.credentials) {
      let value: string;
      try {
        value = await options.resolver.resolve(
          credential.secretRef,
          options.signal,
        );
      } catch {
        throw issue(
          [
            "providers",
            config.providers.indexOf(provider),
            "credentials",
            provider.credentials.indexOf(credential),
            "secretRef",
          ],
          "secret resolution failed",
        );
      }
      try {
        await options.consumeSecret({
          scope: "provider-credential",
          ownerId: credential.id,
          reference: credential.secretRef,
          value,
        });
      } catch {
        throw issue(
          [
            "providers",
            config.providers.indexOf(provider),
            "credentials",
            provider.credentials.indexOf(credential),
            "secretRef",
          ],
          "secret consumption failed",
        );
      }
    }
  }
  return config;
}
