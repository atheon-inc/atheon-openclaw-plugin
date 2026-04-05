import * as atheon from "@atheon-inc/codex";
import type { AtheonCodexClientOptions } from "@atheon-inc/codex";
import { OpenClawPluginService } from "openclaw/plugin-sdk/core";
import { formatError } from "./utils.js";

export function createAtheonCodexService(
  config: AtheonCodexClientOptions,
): OpenClawPluginService {
  return {
    id: "atheon-codex",
    async start({ logger }) {
      try {
        await atheon.init({
          apiKey: config.apiKey,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          ...(config.uploadSize ? { uploadSize: config.uploadSize } : {}),
          ...(config.uploadInterval
            ? { uploadInterval: config.uploadInterval }
            : {}),
        });
        logger.info("[atheon-openclaw] client ready");
      } catch (err) {
        logger.warn(
          `[atheon-openclaw] client init failed — ${formatError(err)}`,
        );
        return;
      }
    },

    async stop() {
      await atheon.shutdown();
    },
  };
}
