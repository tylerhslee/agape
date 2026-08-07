import {
  deriveStableAgentInstanceId,
  run as runtimeRun,
  type RunOptions,
  type RuntimeIdentityContext,
} from "../src/interp.js";

export const TEST_RUNTIME_IDENTITY: RuntimeIdentityContext = Object.freeze({
  projectSubject: "test://agape",
  sessionLineageId: "test-lineage",
  sessionId: "test-session",
  conversationId: "test-conversation",
});
export const TEST_AGENT_INSTANCE_ID = deriveStableAgentInstanceId(
  TEST_RUNTIME_IDENTITY.projectSubject,
  TEST_RUNTIME_IDENTITY.sessionLineageId,
  0,
);

export type TestRunOptions = Omit<RunOptions, "identity"> & {
  identity?: RuntimeIdentityContext;
};

export function run(
  program: Parameters<typeof runtimeRun>[0],
  opts: TestRunOptions = {},
) {
  return runtimeRun(program, { identity: TEST_RUNTIME_IDENTITY, ...opts });
}

