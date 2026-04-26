import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createBeforeAgentReplyHandler, validateRules, type HostBindings } from "./src/runtime.js";

function bindHost(api: OpenClawPluginApi): HostBindings {
  const a = api as OpenClawPluginApi & {
    resolvePath?: (input: string) => string;
    rootDir?: string;
  };
  return {
    logger: api.logger,
    pluginConfig: api.pluginConfig,
    resolvePath: a.resolvePath?.bind(a),
    rootDir: a.rootDir,
  };
}

export { createBeforeAgentReplyHandler };

export default definePluginEntry({
  id: "smart-cron",
  name: "Smart Cron",
  description: "Gate scheduled OpenClaw runs or execute cron-driven tasks without waking the model.",
  register(api) {
    const host = bindHost(api);
    void validateRules(host);
    // Cast: the runtime returns an inert handled-marker; reply is never set,
    // so the structural difference between our local HookResult.reply (unknown)
    // and the SDK's ReplyPayload is safe to widen at this boundary.
    api.on(
      "before_agent_reply",
      createBeforeAgentReplyHandler(host) as Parameters<typeof api.on<"before_agent_reply">>[1],
    );
  },
});
