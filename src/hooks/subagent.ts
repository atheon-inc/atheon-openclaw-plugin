import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { ChildInteraction } from "@atheon-inc/codex";
import type { SessionRegistry } from "../session_registry.js";
import { nonEmptyString, formatError } from "../utils.js";

type SubagentHooksDeps = {
  api: OpenClawPluginApi;
  registry: SessionRegistry;
  logger: {
    warn: (message: string) => void;
  };
};

export function registerSubagentHooks(deps: SubagentHooksDeps): void {
  deps.api.on("subagent_spawning", (event, subagentCtx) => {
    const requesterSessionKey = nonEmptyString(subagentCtx.requesterSessionKey);
    const childSessionKey =
      nonEmptyString(event.childSessionKey) ??
      nonEmptyString(subagentCtx.childSessionKey);

    if (!childSessionKey || !requesterSessionKey) return;

    const parentNode = deps.registry.getNode(requesterSessionKey);
    if (!parentNode || parentNode.status !== "ACTIVE") return;

    parentNode.lastActivityAt = Date.now();

    const agentName = nonEmptyString(event.agentId) ?? "subagent";

    let childInteraction: ChildInteraction;

    try {
      [childInteraction] = parentNode.interaction.spawnChildInteraction({
        agentName,
        parent: parentNode.interaction,
        properties: {
          childSessionKey,
          requesterSessionKey,
          mode: event.mode,
          label: event.label,
        },
      });
    } catch (err) {
      deps.logger.warn(
        `[atheon-openclaw] spawnChildInteraction failed (childSessionKey=${childSessionKey}): ${formatError(err)}`,
      );
      return;
    }

    const childNode = deps.registry.createChildNode(
      childSessionKey,
      requesterSessionKey,
      childInteraction,
    );

    if (!childNode) {
      deps.logger.warn(
        `[atheon-openclaw] createChildNode returned undefined — parent not found (childSessionKey=${childSessionKey})`,
      );
      return;
    }
  });

  deps.api.on("subagent_spawned", (event, subagentCtx) => {
    const requesterSessionKey = nonEmptyString(subagentCtx.requesterSessionKey);
    const childSessionKey =
      nonEmptyString(event.childSessionKey) ??
      nonEmptyString(subagentCtx.childSessionKey);
    if (!childSessionKey || !requesterSessionKey) return;

    const childNode = deps.registry.getNode(childSessionKey);
    if (
      !childNode ||
      childNode.status !== "ACTIVE" ||
      childNode.parentSessionKey !== requesterSessionKey
    )
      return;

    childNode.lastActivityAt = Date.now();

    const parentNode = deps.registry.getNode(requesterSessionKey);
    if (parentNode) parentNode.lastActivityAt = Date.now();

    try {
      childNode.interaction.setProperty(
        "runId",
        nonEmptyString(event.runId) ?? nonEmptyString(subagentCtx.runId),
      );
      childNode.interaction.setProperty("spawnedAgentId", event.agentId);
      childNode.interaction.setProperty(
        "threadRequested",
        event.threadRequested,
      );
    } catch (err) {
      deps.logger.warn(
        `[atheon-openclaw] failed to set subagent properties: ${formatError(err)}`,
      );
    }
  });

  deps.api.on("subagent_ended", (event, subagentCtx) => {
    const requesterSessionKey = nonEmptyString(subagentCtx.requesterSessionKey);
    if (!requesterSessionKey) return;

    const parentNode = deps.registry.getNode(requesterSessionKey);
    if (!parentNode || parentNode.status !== "ACTIVE") return;

    parentNode.lastActivityAt = Date.now();

    const candidateKeys = [
      nonEmptyString(subagentCtx.childSessionKey),
      nonEmptyString(event.targetSessionKey),
    ];

    const resolvedKey = candidateKeys.find((key): key is string => {
      if (key === undefined) return false;
      const node = deps.registry.getNode(key);
      return (
        node !== undefined && node.parentSessionKey === requesterSessionKey
      );
    });

    if (!resolvedKey) {
      deps.logger.warn(
        `[atheon-openclaw] subagent_ended could not resolve child (requesterSessionKey=${requesterSessionKey}, candidates=${JSON.stringify(candidateKeys)})`,
      );
      return;
    }

    const childNode = deps.registry.getNode(resolvedKey)!;

    try {
      childNode.interaction.setProperty("outcome", event.outcome);
      childNode.interaction.setProperty("reason", event.reason);
      if (event.endedAt)
        childNode.interaction.setProperty("endedAt", event.endedAt);
    } catch (err) {
      deps.logger.warn(
        `[atheon-openclaw] failed to set subagent properties: ${formatError(err)}`,
      );
    }

    const errorText =
      typeof event.error === "string" && event.error.length > 0
        ? event.error
        : undefined;

    deps.registry.closeChild(resolvedKey, errorText);
  });
}
