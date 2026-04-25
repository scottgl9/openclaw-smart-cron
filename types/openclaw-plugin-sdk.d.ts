// Minimal ambient types for the OpenClaw plugin SDK surface this plugin uses.
// Kept local so the plugin typechecks without depending on a sibling openclaw
// checkout or a heavy `openclaw` npm install. The real types are provided by
// the OpenClaw runtime at load time; if that surface drifts, update here.

declare module "openclaw/plugin-sdk/plugin-entry" {
  export type PluginLogger = {
    info(msg: string, ...rest: unknown[]): void;
    warn(msg: string, ...rest: unknown[]): void;
    error(msg: string, ...rest: unknown[]): void;
  };

  export type PluginHookAgentContext = {
    runId?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    modelProviderId?: string;
    modelId?: string;
    messageProvider?: string;
    trigger?: string;
    channelId?: string;
  };

  export type PluginHookBeforeAgentReplyEvent = {
    cleanedBody: string;
  };

  export type PluginHookBeforeAgentReplyResult = {
    handled: boolean;
    reply?: unknown;
    reason?: string;
  };

  export type OpenClawPluginApi = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    rootDir?: string;
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    resolvePath?: (input: string) => string;
    on: <K extends "before_agent_reply">(
      hookName: K,
      handler: (
        event: PluginHookBeforeAgentReplyEvent,
        ctx: PluginHookAgentContext,
      ) => Promise<PluginHookBeforeAgentReplyResult | void> | PluginHookBeforeAgentReplyResult | void,
      opts?: { priority?: number },
    ) => void;
  };

  export type DefinePluginEntryOptions = {
    id: string;
    name: string;
    description: string;
    register: (api: OpenClawPluginApi) => void;
  };

  export function definePluginEntry(opts: DefinePluginEntryOptions): unknown;
}
