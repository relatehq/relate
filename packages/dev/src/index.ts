export { describeManifest, diffManifests, summarizeDiff } from './diff.js';
export { LinePrefixer, streamPrefix } from './streams.js';
export { ListenError, bindLoopback } from './listener.js';

export { acquireLock, devDirectory, lockPath, processAlive } from './lock.js';

export type { AcquireResult, Lock, LockMetadata } from './lock.js';
export { ProjectError, resolveProject } from './project.js';
export { createSessions } from './session.js';
export type { Sessions } from './session.js';
export { Supervisor } from './supervisor.js';
export type { SupervisorState } from './supervisor.js';
export { createDevServer } from './server.js';

export {
  PlaygroundRequestError,
  createPlayground,
  mountPlaygroundRoutes,
} from './playground.js';

export type { Playground, PlaygroundOptions } from './playground.js';
export { createBuilder, esbuildDiagnostics } from './build.js';
export { createWatcher } from './watcher.js';
export { createAttemptRunner, defaultWorkerPath } from './attempts.js';
export type { AttemptOutcome } from './attempts.js';
export { startDev, DevStartError } from './start.js';

export type {
  StartDevOptions,
  DevService,
  DevServiceInfo,
  DevServiceEvent,
} from './start.js';

export {
  DEFAULT_PORT_RANGE,
  DEFAULT_EVAL_TIMEOUT_MS,
  MAX_TIMER_MS,
  DevOptionsError,
  normalizeAllowedOrigin,
  normalizeDevOptions,
} from './options.js';

export {
  DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS,
  DEFAULT_RUNTIME_START_TIMEOUT_MS,
  RuntimeUnavailableError,
  createRuntimeController,
  defaultRuntimeHostPath,
} from './runtime-controller.js';

export type {
  AcceptedBuild,
  RuntimeController,
  RuntimeControllerOptions,
} from './runtime-controller.js';

export { createRuntimeBinding, snapshotDiscovery } from './runtime-binding.js';

export type { RuntimeBinding, RuntimeConnection } from './runtime-binding.js';

export {
  encodeError,
  encodeRuntimeHostArguments,
  restoreError,
  userCodeEnvironment,
  withheldVariables,
} from './runtime-protocol.js';

export type {
  DiscoverySnapshot,
  RuntimeMessage,
  RuntimeRequest,
  WireError,
} from './runtime-protocol.js';

export {
  activityLimits,
  createActivityLog,
  observeDispatch,
  observeExecutor,
  observeRequest,
  projectActivity,
  requestIdMeta,
} from './activity/index.js';

export type {
  ActivityLog,
  CallObservation,
  CallSource,
} from './activity/index.js';

export {
  createMcpEndpoint,
  createMcpToken,
  mcpAddCommand,
  readMcpToken,
} from './mcp.js';

export type { McpEndpoint, McpEndpointOptions } from './mcp.js';

export {
  AgentRequestError,
  agentEffort,
  agentMaxModelCalls,
  agentMaxTokens,
  agentModel,
  agentSetup,
  runtimeRestartedNote,
  connectLoopbackMcp,
  createAgent,
  mountAgentRoutes,
  systemPrompt,
  toAnthropicTools,
  toToolResult,
} from './agent.js';

export type {
  Agent,
  AgentModelClient,
  AgentModelStream,
  AgentOptions,
  AgentStreamParams,
  AgentToolSession,
  ConnectAgentTools,
} from './agent.js';
