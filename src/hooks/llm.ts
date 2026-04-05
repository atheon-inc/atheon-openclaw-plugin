import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { Interaction, ChildInteraction } from "@atheon-inc/codex";
import * as atheon from "@atheon-inc/codex";
import { sanitizeValue } from "../payload_sanitizer.js";
import type { SessionRegistry } from "../session_registry.js";
import {
  normalizeProvider,
  resolveChannelId,
  resolveTrigger,
  formatError,
} from "../utils.js";

type LlmHooksDeps = {
  api: OpenClawPluginApi;
  registry: SessionRegistry;
  logger: {
    warn: (message: string) => void;
  };
};

export function registerLlmHooks(deps: LlmHooksDeps): void {
  deps.api.on("llm_input", (event, agentCtx) => {
    const sessionKey = agentCtx.sessionKey;
    if (!sessionKey) return;

    const existingNode = deps.registry.getNode(sessionKey);

    if (
      existingNode !== undefined &&
      existingNode.parentSessionKey !== undefined
    ) {
      existingNode.lastActivityAt = Date.now();

      const provider =
        normalizeProvider(event.provider) ??
        (event.provider as string) ??
        "unknown";
      const modelName: string = event.model ?? "unknown";

      try {
        existingNode.interaction.setProviderAndModelName({
          provider,
          modelName,
        });
      } catch (err) {
        deps.logger.warn(
          `[atheon-openclaw] failed to update provider/model: ${formatError(err)}`,
        );
      }

      deps.registry.linkAgent(sessionKey, agentCtx.agentId);
      return;
    }

    const provider =
      normalizeProvider(event.provider) ??
      (event.provider as string) ??
      "unknown";
    const modelName: string = event.model ?? "unknown";

    const properties: Record<string, unknown> = {
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
      ...(agentCtx.agentId ? { agentId: agentCtx.agentId } : {}),
    };

    const channelId = resolveChannelId(agentCtx as Record<string, unknown>);
    if (channelId) properties.channel = channelId;

    const trigger = resolveTrigger(agentCtx as Record<string, unknown>);
    if (trigger) properties.trigger = trigger;

    const sanitizedLlmInput = sanitizeValue({
      prompt: event.prompt,
      systemPrompt: event.systemPrompt,
      historyMessages: event.historyMessages,
      imagesCount: event.imagesCount,
    }) as Record<string, unknown>;

    let interaction: Interaction;

    try {
      [interaction] = atheon.begin({
        provider,
        modelName,
        input:
          typeof sanitizedLlmInput.prompt === "string"
            ? sanitizedLlmInput.prompt
            : JSON.stringify(sanitizedLlmInput.prompt),
        conversationId: sessionKey,
        properties,
      });
    } catch (err) {
      deps.logger.warn(
        `[atheon-openclaw] interaction begin failed (sessionKey=${sessionKey}): ${formatError(err)}`,
      );
      return;
    }

    const node = deps.registry.createRootNode(sessionKey, interaction);
    deps.registry.linkAgent(node.sessionKey, agentCtx.agentId);
  });

  deps.api.on("llm_output", (event, agentCtx) => {
    const sessionKey = agentCtx.sessionKey;
    if (!sessionKey) return;

    deps.registry.linkAgent(sessionKey, agentCtx.agentId);

    const node = deps.registry.getNode(sessionKey);
    if (!node || node.status !== "ACTIVE") return;

    node.lastActivityAt = Date.now();

    const sanitizedLlmOutput = sanitizeValue({
      assistantTexts: event.assistantTexts,
      lastAssistant: event.lastAssistant,
    }) as { assistantTexts?: unknown };

    const sanitizedAssistantTexts = Array.isArray(
      sanitizedLlmOutput.assistantTexts,
    )
      ? sanitizedLlmOutput.assistantTexts.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    const outputText = sanitizedAssistantTexts.join("\n\n");

    const usage = event.usage as Record<string, unknown> | undefined;
    const tokensInput =
      typeof usage?.input === "number" ? usage.input : undefined;
    const tokensOutput =
      typeof usage?.output === "number" ? usage.output : undefined;

    if (node.parentSessionKey !== undefined) {
      node.outputText = null;

      try {
        (node.interaction as ChildInteraction).setMetrics({
          ...(tokensInput !== undefined ? { tokensInput } : {}),
          ...(tokensOutput !== undefined ? { tokensOutput } : {}),
          finishReason: "stop",
        });
      } catch (err) {
        deps.logger.warn(
          `[atheon-openclaw] failed to set subagent metrics: ${formatError(err)}`,
        );
      }

      return;
    }

    node.outputText = outputText;

    const finishArgs = {
      output: outputText,
      finishReason: "stop" as const,
      ...(tokensInput !== undefined ? { tokensInput } : {}),
      ...(tokensOutput !== undefined ? { tokensOutput } : {}),
    };

    if (node.toolTimings.size > 0) {
      if (node.pendingFinish !== undefined) {
        deps.logger.warn(
          `[atheon-openclaw] llm_output received while pendingFinish already set (sessionKey=${sessionKey}) — overwriting previous pending finish`,
        );
      }
      node.pendingFinish = finishArgs;
      return;
    }

    try {
      (node.interaction as Interaction).finish(finishArgs);
    } catch (err) {
      deps.logger.warn(
        `[atheon-openclaw] interaction finish failed (sessionKey=${sessionKey}): ${formatError(err)}`,
      );
    } finally {
      deps.registry.removeNode(sessionKey);
    }
  });
}
