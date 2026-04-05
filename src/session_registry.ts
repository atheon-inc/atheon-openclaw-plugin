import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { Interaction, ChildInteraction } from "@atheon-inc/codex";
import { formatError } from "./utils.js";

export type NodeStatus = "ACTIVE" | "RESOLVED" | "CLOSED";

export interface PendingFinish {
  output: string;
  finishReason: string;
  tokensInput?: number;
  tokensOutput?: number;
}

export interface PendingClose {
  error?: string;
}

export interface ToolTimingEntry {
  toolName: string;
  startTimes: number[];
}

export interface InteractionNode {
  readonly sessionKey: string;
  readonly parentSessionKey: string | undefined;

  status: NodeStatus;

  interaction: Interaction | ChildInteraction;

  outputText: string | null | undefined;

  pendingFinish?: PendingFinish;
  pendingClose?: PendingClose;

  childSessionKeys: Set<string>;
  linkedAgentIds: Set<string>;
  toolTimings: Map<string, ToolTimingEntry>;
  lastActivityAt: number;
}

export class SessionRegistry {
  private readonly nodes = new Map<string, InteractionNode>();
  private readonly agentToSession = new Map<string, string>();

  private readonly maxIdleTimeMs: number;

  constructor(
    private readonly logger: OpenClawPluginApi["logger"],
    opts?: { maxIdleTimeMs?: number },
  ) {
    this.maxIdleTimeMs = opts?.maxIdleTimeMs ?? 60 * 60 * 1000;
  }

  private cleanupNodeMemory(node: InteractionNode): void {
    if (node.parentSessionKey !== undefined) {
      const parent = this.nodes.get(node.parentSessionKey);
      if (parent) parent.childSessionKeys.delete(node.sessionKey);
    }
    for (const agentId of node.linkedAgentIds) {
      this.agentToSession.delete(agentId);
    }
    this.nodes.delete(node.sessionKey);
    node.status = "CLOSED";
    node.linkedAgentIds.clear();
    node.childSessionKeys.clear();
    node.toolTimings.clear();
  }

  private safeExecute(fn: () => void, context: string): void {
    try {
      fn();
    } catch (err) {
      this.logger.warn(
        `[atheon-openclaw] ${context} failed: ${formatError(err)}`,
      );
    }
  }

  createRootNode(
    sessionKey: string,
    interaction: Interaction,
  ): InteractionNode {
    const existing = this.nodes.get(sessionKey);
    if (existing) {
      this.logger.warn(
        `[atheon-openclaw] createRootNode called for existing sessionKey=${sessionKey} — closing existing node first`,
      );
      this.closeRoot(sessionKey, "replaced by new root node");
    }

    const node: InteractionNode = {
      sessionKey,
      parentSessionKey: undefined,
      status: "ACTIVE",
      interaction,
      outputText: "",
      childSessionKeys: new Set(),
      linkedAgentIds: new Set(),
      toolTimings: new Map(),
      lastActivityAt: Date.now(),
    };
    this.nodes.set(sessionKey, node);
    return node;
  }

  createChildNode(
    childSessionKey: string,
    parentSessionKey: string,
    interaction: ChildInteraction,
  ): InteractionNode | undefined {
    const parent = this.nodes.get(parentSessionKey);
    if (!parent) return undefined;

    const existing = this.nodes.get(childSessionKey);
    if (existing) {
      this.closeChild(childSessionKey, "subagent reset — new spawn initiated");
    }

    const node: InteractionNode = {
      sessionKey: childSessionKey,
      parentSessionKey,
      status: "ACTIVE",
      interaction,
      outputText: "",
      childSessionKeys: new Set(),
      linkedAgentIds: new Set(),
      toolTimings: new Map(),
      lastActivityAt: Date.now(),
    };

    this.nodes.set(childSessionKey, node);
    parent.childSessionKeys.add(childSessionKey);
    parent.lastActivityAt = Date.now();
    return node;
  }

  getNode(sessionKey: string): InteractionNode | undefined {
    return this.nodes.get(sessionKey);
  }

  removeNode(sessionKey: string): void {
    const node = this.nodes.get(sessionKey);
    if (node) this.cleanupNodeMemory(node);
  }

  linkAgent(sessionKey: string, agentId: unknown): void {
    if (typeof agentId !== "string" || agentId.length === 0) return;
    const node = this.nodes.get(sessionKey);
    if (!node) return;
    node.linkedAgentIds.add(agentId);
    this.agentToSession.set(agentId, sessionKey);
    node.lastActivityAt = Date.now();
  }

  resolveSessionKey(rawKey: string): string | undefined {
    if (this.nodes.has(rawKey)) return rawKey;
    return this.agentToSession.get(rawKey);
  }

  resolveToolTarget(
    sessionKey: string,
  ): { node: InteractionNode; rootNode: InteractionNode } | undefined {
    const node = this.nodes.get(sessionKey);
    if (!node || node.status !== "ACTIVE") return undefined;

    if (node.parentSessionKey === undefined) {
      return { node, rootNode: node };
    }

    const rootNode = this.nodes.get(node.parentSessionKey);
    if (!rootNode || rootNode.status !== "ACTIVE") return undefined;

    return { node, rootNode };
  }

  private abandonToolTimings(node: InteractionNode): void {
    for (const [, entry] of node.toolTimings) {
      const { toolName, startTimes } = entry;
      for (const startTime of startTimes) {
        this.safeExecute(() => {
          node.interaction.addToolExecution({
            id: randomUUID(),
            type: "tool",
            name: toolName,
            latency_ms: String(
              Math.min(performance.now() - startTime, this.maxIdleTimeMs),
            ),
            error: "tool call abandoned — interaction closed",
          });
        }, `abandoning tool execution ${toolName}`);
      }
    }
    node.toolTimings.clear();
  }

  tryFlushPendingClose(node: InteractionNode): boolean {
    if (
      node.toolTimings.size !== 0 ||
      node.pendingClose === undefined ||
      node.parentSessionKey === undefined
    ) {
      return false;
    }

    const { error } = node.pendingClose;
    node.pendingClose = undefined;

    this.abandonToolTimings(node);

    this.safeExecute(() => {
      (node.interaction as ChildInteraction).finish(error);
    }, "tryFlushPendingClose");

    this.cleanupNodeMemory(node);
    return true;
  }

  tryFlushPendingFinish(rootNode: InteractionNode): boolean {
    if (
      rootNode.toolTimings.size !== 0 ||
      rootNode.pendingFinish === undefined
    ) {
      return false;
    }

    const finishArgs = rootNode.pendingFinish;
    rootNode.pendingFinish = undefined;

    this.safeExecute(() => {
      (rootNode.interaction as Interaction).finish(finishArgs);
    }, "tryFlushPendingFinish");

    this.removeNode(rootNode.sessionKey);
    return true;
  }

  closeRoot(sessionKey: string, reason: string): void {
    const rootNode = this.nodes.get(sessionKey);
    if (!rootNode || rootNode.status !== "ACTIVE") return;

    this.logger.warn(
      `[atheon-openclaw] closing active interaction — ${reason}`,
    );

    const postOrder: InteractionNode[] = [];
    const stack: InteractionNode[] = [rootNode];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.status !== "ACTIVE") continue;
      postOrder.push(current);
      for (const childKey of current.childSessionKeys) {
        const child = this.nodes.get(childKey);
        if (child && child.status === "ACTIVE") stack.push(child);
      }
    }

    for (let idx = postOrder.length - 1; idx >= 0; idx--) {
      const node = postOrder[idx];
      this.abandonToolTimings(node);

      this.safeExecute(() => {
        if (node.parentSessionKey === undefined) {
          (node.interaction as Interaction).finish({ output: node.outputText });
        } else {
          (node.interaction as ChildInteraction).finish(
            "subagent abandoned — parent interaction closed",
          );
        }
      }, "closeRoot node finish");

      node.status = "RESOLVED";
    }

    for (const node of postOrder) {
      this.cleanupNodeMemory(node);
    }
  }

  closeChild(childSessionKey: string, error?: string): void {
    const node = this.nodes.get(childSessionKey);
    if (!node || node.parentSessionKey === undefined) return;
    if (node.status !== "ACTIVE") return;

    if (node.toolTimings.size > 0) {
      if (node.pendingClose !== undefined) {
        this.logger.warn(
          `[atheon-openclaw] closeChild called twice while tools in-flight (childSessionKey=${childSessionKey}) — ignoring duplicate close`,
        );
        return;
      }
      node.pendingClose = { error };
      return;
    }

    this.abandonToolTimings(node);

    this.safeExecute(() => {
      (node.interaction as ChildInteraction).finish(error);
    }, "closeChild finish");

    this.cleanupNodeMemory(node);
  }

  reapStaleNodes(now: number): void {
    const staleRootKeys: string[] = [];
    const staleOrOrphanedChildKeys: string[] = [];

    for (const node of this.nodes.values()) {
      const isStale = now - node.lastActivityAt > this.maxIdleTimeMs;

      if (node.parentSessionKey === undefined) {
        if (isStale) staleRootKeys.push(node.sessionKey);
      } else {
        if (!this.nodes.has(node.parentSessionKey) || isStale) {
          staleOrOrphanedChildKeys.push(node.sessionKey);
        }
      }
    }

    for (const key of staleRootKeys) {
      this.closeRoot(key, "timeout — session orphaned");
    }

    for (const key of staleOrOrphanedChildKeys) {
      this.logger.warn(
        `[atheon-openclaw] reaping orphaned child interaction — ${key}`,
      );

      const node = this.nodes.get(key);
      if (node && node.status === "ACTIVE") {
        this.abandonToolTimings(node);
        this.safeExecute(() => {
          (node.interaction as ChildInteraction).finish("timeout or orphaned");
        }, "reapStaleNodes child finish");
        this.cleanupNodeMemory(node);
      }
    }
  }
}
