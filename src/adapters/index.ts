/** Boundary adapters exposed without widening Domain or Ports. */
export * from "./providers/index.js";
export * from "./translators/index.js";
export {
  AdapterRegistrationError,
  AtomicAdapterRegistry,
  createBuiltInProtocolAdapterFactory,
  registerProtocolAdapters,
} from "./registry.js";
export type {
  AdapterRegistrationIssue,
  AdapterRegistrationReadiness,
  BuiltInProtocolAdapterFactoryOptions,
  ProtocolAdapterRegistration,
} from "./registry.js";
