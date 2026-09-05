/**
 * ACP (Agent Client Protocol) wire types, aligned with the schema used by
 * iFlow CLI's `--experimental-acp` mode (verified in M0 against CLI 0.5.19).
 * iFlow-specific extensions are marked with `// iFlow extension`.
 */

// ---------------------------------------------------------------------------
// Method names
// ---------------------------------------------------------------------------

export const AcpMethods = {
  initialize: "initialize",
  authenticate: "authenticate",
  newSession: "session/new",
  loadSession: "session/load",
  prompt: "session/prompt",
  cancel: "session/cancel",
  setMode: "session/set_mode",
  setModel: "session/set_model",
  setThink: "session/set_think", // iFlow extension (verify on wire)
  // Agent → Client
  sessionUpdate: "session/update",
  requestPermission: "session/request_permission",
  readTextFile: "fs/read_text_file",
  writeTextFile: "fs/write_text_file",
} as const;

// ---------------------------------------------------------------------------
// Client → Agent: initialize / authenticate
// ---------------------------------------------------------------------------

export interface ClientCapabilities {
  fs?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
  };
  terminal?: boolean;
}

export interface InitializeRequest {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
}

export interface AuthMethod {
  id: string;
  name: string;
  description: string | null;
  _meta?: unknown;
}

export interface AgentInfo {
  name: string;
  title: string;
  version?: string;
}

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
}

export interface InitializeResponse {
  protocolVersion: number;
  /** True when the CLI's persisted credentials are valid (observed on wire, M0). */
  isAuthenticated?: boolean;
  agentCapabilities: AgentCapabilities;
  authMethods: AuthMethod[];
  agentInfo?: AgentInfo;
  _meta?: unknown;
}

export interface AuthenticateRequest {
  methodId: string;
  methodInfo?: {
    apiKey?: string;
    baseUrl?: string;
    modelName?: string;
  };
}

export interface AuthenticateResponse {
  methodId: string;
  userId?: string;
  userName?: string;
  avatar?: string;
  email?: string;
}

// ---------------------------------------------------------------------------
// Client → Agent: session lifecycle
// ---------------------------------------------------------------------------

export interface McpServerEnvVar {
  name: string;
  value: string;
}

export interface McpServerStdio {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: McpServerEnvVar[];
  cwd?: string;
}

export type McpServer = McpServerStdio | { type: "http" | "sse"; url: string; headers?: McpServerEnvVar[] };

export interface NewSessionRequest {
  cwd: string;
  mcpServers: McpServer[];
  sessionId?: string;
  agents?: AgentDefinition[]; // iFlow extension
  hooks?: Record<string, unknown[]>; // iFlow extension
  commands?: unknown[]; // iFlow extension
  settings?: SessionSettings; // iFlow extension
}

export interface AgentDefinition {
  agentType: string;
  name: string;
  description?: string;
  whenToUse?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  model?: string;
}

export interface SessionSettings {
  system_prompt?: string;
  append_system_prompt?: string;
  permission_mode?: string;
  max_turns?: number;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  add_dirs?: string[];
  [key: string]: unknown;
}

export interface SessionMode {
  id: string;
  name: string;
  kind?: "smart" | "yolo" | "plan" | "default" | string;
  description?: string | null;
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  capabilities?: { thinking?: boolean };
}

export interface SlashCommand {
  name: string;
  description?: string | null;
  input?: { hint: string } | null;
  _meta?: { scope?: "project" | "global" | string; altName?: string[] };
}

export interface NewSessionMeta {
  models?: {
    currentModelId: string;
    availableModels: ModelInfo[];
  };
  availableCommands?: SlashCommand[];
  availableAgents?: unknown[];
  availableSkills?: unknown[];
  availableMcpServers?: unknown[];
}

export interface NewSessionResponse {
  sessionId: string;
  modes?: SessionModeState;
  _meta?: NewSessionMeta;
}

// ---------------------------------------------------------------------------
// Client → Agent: prompt
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: "text"; text: string; _meta?: unknown }
  | { type: "image"; data: string; mimeType: string; _meta?: unknown }
  | { type: "audio"; data: string; mimeType: string; _meta?: unknown }
  | { type: "resource_link"; uri: string; name: string; _meta?: unknown }
  | { type: "resource"; resource: unknown; _meta?: unknown };

export interface PromptRequest {
  sessionId: string;
  prompt: ContentBlock[];
}

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string;

export interface PromptResponse {
  stopReason: StopReason;
}

export interface CancelNotification {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Agent → Client: session/update notifications
// ---------------------------------------------------------------------------

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other" | string;

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolLocation {
  path: string;
  line?: number | null;
}

export type ToolContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText?: string };

export interface ToolCallBase {
  toolCallId: string;
  toolName?: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  locations?: ToolLocation[];
  content?: ToolContent[];
  _meta?: unknown;
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | ({ sessionUpdate: "tool_call" } & ToolCallBase)
  | ({ sessionUpdate: "tool_call_update" } & ToolCallBase)
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: SlashCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string };

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low";
  status?: "pending" | "in_progress" | "completed";
}

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
  agentId?: string; // iFlow: SubAgent lifecycle events carry an agentId
}

// ---------------------------------------------------------------------------
// Agent → Client: requests the extension host must answer
// ---------------------------------------------------------------------------

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionRequest {
  sessionId: string;
  toolCall: ToolCallBase;
  options: PermissionOption[];
}

export type RequestPermissionResponse = {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
};

export interface ReadTextFileRequest {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface ReadTextFileResponse {
  content: string;
}

export interface WriteTextFileRequest {
  sessionId: string;
  path: string;
  content: string;
}
