import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { parseRawConfigIntoAtheonCodexClientOptions } from "./utils.js";
import { createAtheonCodexService } from "./service.js";
import { SessionRegistry } from "./session_registry.js";
import { registerLlmHooks } from "./hooks/llm.js";
import { registerToolHooks } from "./hooks/tool.js";
import { registerSubagentHooks } from "./hooks/subagent.js";

export const __version__ = "0.1.0-dev.1";

export default definePluginEntry({
  id: "atheon-openclaw",
  name: "atheon",
  description:
    "Export LLM, Tools and SubAgent analytics to Atheon using atheon-codex",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    const atheonCodexClientOptions = parseRawConfigIntoAtheonCodexClientOptions(
      api.pluginConfig,
    );

    const REAPER_INTERVAL_MS = 5 * 60 * 1000;
    const MAX_IDLE_TIME_MS = 60 * 60 * 1000;

    const registry = new SessionRegistry(api.logger, {
      maxIdleTimeMs: MAX_IDLE_TIME_MS,
    });

    let reaperInterval: ReturnType<typeof setInterval> | undefined;

    api.on("gateway_start", () => {
      reaperInterval = setInterval(() => {
        registry.reapStaleNodes(Date.now());
      }, REAPER_INTERVAL_MS);
      if (reaperInterval?.unref) reaperInterval.unref();
    });

    api.on("gateway_stop", () => {
      if (reaperInterval) {
        clearInterval(reaperInterval);
        reaperInterval = undefined;
      }
    });

    registerLlmHooks({
      api,
      registry,
      logger: { warn: (msg) => api.logger.warn(msg) },
    });

    registerToolHooks({
      api,
      registry,
      logger: { warn: (msg) => api.logger.warn(msg) },
    });

    registerSubagentHooks({
      api,
      registry,
      logger: { warn: (msg) => api.logger.warn(msg) },
    });

    api.on("session_end", (_event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (typeof sessionKey !== "string") return;
      registry.closeRoot(sessionKey, `session_end sessionKey=${sessionKey}`);
    });

    api.registerService(createAtheonCodexService(atheonCodexClientOptions));
  },
});
