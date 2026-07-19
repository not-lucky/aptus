/** Exact credential lifecycle states used by routing policy. */
export type CredentialState = "active" | "cooldown" | "critical_failure" | "suspended";

/** Injected state machine port for one credential identity. */
export interface CredentialStatePort {
  /** Reads the authoritative current state. */
  state(credentialId: string): CredentialState;
  /** Applies one validated state transition. */
  transition(credentialId: string, next: CredentialState): void;
}
