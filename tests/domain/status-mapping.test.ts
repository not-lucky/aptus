import { describe, expect, it } from "vitest";

import type { FinishReason, ResponseStatus } from "../../src/domain/index.js";
import {
  deriveResponseStatus,
  finishReasonToStatus,
  isContinuableFinishReason,
  isTerminalStatus,
} from "../../src/domain/index.js";

describe("finishReasonToStatus", () => {
  const cases: [FinishReason, ResponseStatus][] = [
    ["stop", "completed"],
    ["max_tokens", "completed"],
    ["stop_sequence", "completed"],
    ["tool_calls", "completed"],
    ["refusal", "completed"],
    ["content_filter", "completed"],
    ["incomplete", "incomplete"],
    ["cancelled", "cancelled"],
    ["pause_turn", "in_progress"],
    ["error", "failed"],
  ];
  it.each(cases)("maps %s to %s", (reason, status) => {
    expect(finishReasonToStatus(reason)).toBe(status);
  });
});

describe("isTerminalStatus", () => {
  it.each<[ResponseStatus, boolean]>([
    ["queued", false],
    ["in_progress", false],
    ["completed", true],
    ["incomplete", true],
    ["failed", true],
    ["cancelled", true],
  ])("classifies %s terminal=%s", (status, terminal) => {
    expect(isTerminalStatus(status)).toBe(terminal);
  });
});

describe("isContinuableFinishReason", () => {
  it("is true only for pause_turn", () => {
    expect(isContinuableFinishReason("pause_turn")).toBe(true);
    expect(isContinuableFinishReason("stop")).toBe(false);
    expect(isContinuableFinishReason("error")).toBe(false);
  });
});

describe("deriveResponseStatus", () => {
  it("prioritizes an explicit error", () => {
    expect(
      deriveResponseStatus({ finishReasons: ["stop"], hasError: true }),
    ).toBe("failed");
  });

  it.each<[FinishReason[], ResponseStatus]>([
    [["stop"], "completed"],
    [["stop", "cancelled"], "cancelled"],
    [["stop", "error"], "failed"],
    [["stop", "pause_turn"], "in_progress"],
    [["stop", "incomplete"], "incomplete"],
  ])("derives %j to %s", (finishReasons, status) => {
    expect(deriveResponseStatus({ finishReasons, hasError: false })).toBe(
      status,
    );
  });
});
