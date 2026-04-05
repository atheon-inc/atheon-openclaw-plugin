import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { ToolRecord } from "@atheon-inc/codex";
import type { SessionRegistry } from "../session_registry.js";
import { resolveToolCallId, buildSpanKey, formatError } from "../utils.js";
import { randomUUID } from "node:crypto";

type ToolHooksDeps = {
  api: OpenClawPluginApi;
  registry: SessionRegistry;
  logger: {
    warn: (message: string) => void;
  };
};

export function registerToolHooks(deps: ToolHooksDeps): void {
  let missingSessionKeyWarnCount = 0;
  const MISSING_SESSION_KEY_WARN_LIMIT = 5;

  deps.api.on("before_tool_call", (event, toolCtx) => {
    const sessionKey = toolCtx.sessionKey;
    if (!sessionKey) return;

    const resolved = deps.registry.resolveToolTarget(sessionKey);
    if (!resolved) return;

    deps.registry.linkAgent(resolved.rootNode.sessionKey, toolCtx.agentId);
    resolved.node.lastActivityAt = Date.now();

    const toolName = event.toolName as string;
    const toolCallId = resolveToolCallId(event, toolCtx);
    const spanKey = buildSpanKey(sessionKey, toolName, toolCallId);

    const existing = resolved.node.toolTimings.get(spanKey);
    if (existing) {
      existing.startTimes.push(performance.now());
    } else {
      resolved.node.toolTimings.set(spanKey, {
        toolName,
        startTimes: [performance.now()],
      });
    }
  });

  deps.api.on("after_tool_call", (event, toolCtx) => {
    const toolName: string = (event.toolName as string) ?? "unknown";
    const toolCallId = resolveToolCallId(event, toolCtx);

    let sessionKey: string | undefined = toolCtx.sessionKey;

    if (!sessionKey) {
      const byAgentId =
        typeof toolCtx.agentId === "string"
          ? deps.registry.resolveSessionKey(toolCtx.agentId)
          : undefined;

      if (byAgentId !== undefined) {
        sessionKey = byAgentId;

        if (missingSessionKeyWarnCount < MISSING_SESSION_KEY_WARN_LIMIT) {
          missingSessionKeyWarnCount++;
          const suffix =
            missingSessionKeyWarnCount === MISSING_SESSION_KEY_WARN_LIMIT
              ? " (further occurrences suppressed)"
              : "";
          deps.logger.warn(
            `[atheon-openclaw] after_tool_call missing sessionKey — resolved via agentId (tool=${toolName})${suffix}`,
          );
        }
      }
    }

    if (!sessionKey) return;

    const resolved = deps.registry.resolveToolTarget(sessionKey);
    if (!resolved) return;

    const { node, rootNode } = resolved;
    deps.registry.linkAgent(rootNode.sessionKey, toolCtx.agentId);
    node.lastActivityAt = Date.now();

    const spanKey = buildSpanKey(sessionKey, toolName, toolCallId);
    let startTime: number | undefined;

    const toolTimingQueue = node.toolTimings.get(spanKey);
    if (toolTimingQueue && toolTimingQueue.startTimes.length > 0) {
      startTime = toolTimingQueue.startTimes.shift();
      if (toolTimingQueue.startTimes.length === 0) {
        node.toolTimings.delete(spanKey);
      }
    }

    const latencyMs =
      event.durationMs ??
      (startTime !== undefined ? performance.now() - startTime : 0);

    const errorText = event.error || undefined;

    const record: ToolRecord = {
      id: randomUUID(),
      type: "tool",
      name: toolName,
      latency_ms: String(latencyMs),
      error: errorText,
    };

    try {
      node.interaction.addToolExecution(record);
    } catch (err) {
      deps.logger.warn(
        `[atheon-openclaw] addToolExecution failed (tool=${toolName}): ${formatError(err)}`,
      );
    }

    if (node !== rootNode) {
      deps.registry.tryFlushPendingClose(node);
    }

    deps.registry.tryFlushPendingFinish(rootNode);
  });
}
