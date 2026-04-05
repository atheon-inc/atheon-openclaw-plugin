import type { AtheonCodexClientOptions } from "@atheon-inc/codex";

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function normalizeProvider(provider: unknown): string | undefined {
  if (typeof provider !== "string") return undefined;
  const p = provider.toLowerCase();
  if (p.includes("anthropic")) return "anthropic";
  if (p.includes("openai")) return "openai";
  if (p.includes("google") || p.includes("gemini")) return "google";
  if (p.includes("mistral")) return "mistral";
  if (p.includes("cohere")) return "cohere";
  return p;
}

export function resolveChannelId(
  ctx: Record<string, unknown>,
): string | undefined {
  const channel = ctx.channel ?? ctx.channelId ?? ctx.channelType;
  return typeof channel === "string" && channel.length > 0
    ? channel
    : undefined;
}

export function resolveToolCallId(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): string | undefined {
  const id = event.toolCallId ?? ctx.toolCallId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function resolveTrigger(
  ctx: Record<string, unknown>,
): string | undefined {
  const trigger = ctx.trigger ?? ctx.triggerType;
  return typeof trigger === "string" && trigger.length > 0
    ? trigger
    : undefined;
}

export function buildSpanKey(
  sessionKey: string,
  toolName: string,
  toolCallId?: string,
): string {
  return `session:${sessionKey}:tool:${toolName}:${toolCallId ?? "no-id-fallback"}`;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseRawConfigIntoAtheonCodexClientOptions(
  raw: unknown,
): AtheonCodexClientOptions {
  const obj =
    raw != null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};

  const apiKey =
    typeof obj.apiKey === "string"
      ? obj.apiKey
      : (process.env.ATHEON_API_KEY ?? "");
  if (!apiKey) {
    throw new Error(
      "[atheon-openclaw] 'apiKey' is required. Set it in the plugin config or via ATHEON_API_KEY.",
    );
  }

  return {
    apiKey,
    baseUrl: typeof obj.baseUrl === "string" ? obj.baseUrl : undefined,
    uploadSize: typeof obj.uploadSize === "number" ? obj.uploadSize : undefined,
    uploadInterval:
      typeof obj.uploadInterval === "number" ? obj.uploadInterval : undefined,
  };
}
