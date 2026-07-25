import {
  createProviderOrigin,
  type ProviderOrigin,
  type QueuedResponse,
  type RecordedRequest,
  type ResponseMode,
} from "./provider-origin.js";

export type { ResponseMode, QueuedResponse, RecordedRequest };

/**
 * A loopback Chat origin used to exercise the dispatcher and process paths
 * deterministically without external network access.
 */
export type ChatOrigin = ProviderOrigin;

/**
 * Starts a loopback Chat origin on `127.0.0.1:0` with base path `"/v1"`.
 *
 * @returns An initialized {@link ChatOrigin}.
 */
export async function createChatOrigin(): Promise<ChatOrigin> {
  return createProviderOrigin({ basePath: "/v1" });
}
