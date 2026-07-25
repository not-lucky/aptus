import { createProviderOrigin, type ProviderOrigin } from "./provider-origin.js";

/**
 * Three-origin provider harness managing Chat, Responses, and Messages loopback origins
 * concurrently on distinct loopback ports.
 */
export interface ThreeOriginHarness {
  readonly chatOrigin: ProviderOrigin;
  readonly responsesOrigin: ProviderOrigin;
  readonly messagesOrigin: ProviderOrigin;
  resetAll(): void;
  closeAll(): Promise<void>;
}

/**
 * Spawns three independent provider origins on distinct loopback ports.
 *
 * - `chatOrigin`: base path `"/v1"` (requests target `/v1/chat/completions`)
 * - `responsesOrigin`: base path `"/v1"` (requests target `/v1/responses`)
 * - `messagesOrigin`: base path `""` (requests target `/v1/messages`)
 *
 * @returns An initialized {@link ThreeOriginHarness}.
 */
export async function createThreeOriginHarness(): Promise<ThreeOriginHarness> {
  const [chatOrigin, responsesOrigin, messagesOrigin] = await Promise.all([
    createProviderOrigin({ basePath: "/v1" }),
    createProviderOrigin({ basePath: "/v1" }),
    createProviderOrigin({ basePath: "" }),
  ]);

  return {
    chatOrigin,
    responsesOrigin,
    messagesOrigin,
    resetAll() {
      chatOrigin.reset();
      responsesOrigin.reset();
      messagesOrigin.reset();
    },
    async closeAll() {
      await Promise.all([chatOrigin.close(), responsesOrigin.close(), messagesOrigin.close()]);
    },
  };
}
