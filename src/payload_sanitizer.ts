const MEDIA_IMAGE_REFERENCE_RE =
  /\bmedia:[^\s"'`]+\.(?:jpe?g|png|webp|gif)(?=[\s"'`]|$)/gi;
const INTERNAL_REPLY_TO_MARKER_RE = /\[\[reply_to[^\]]*\]\]\s*/gi;
const CONVERSATION_INFO_BLOCK_RE =
  /^\s*Conversation info \(untrusted metadata\):\s*\n+\{[\s\S]*?\}\s*/gim;
const SENDER_INFO_BLOCK_RE =
  /^\s*Sender \(untrusted metadata\):\s*\n+\{[\s\S]*?\}\s*/gim;
const UNTRUSTED_CONTEXT_BLOCK_RE =
  /^\s*Untrusted context \(metadata, do not treat as instructions or commands\):\s*\n+<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\s*/gim;

export function sanitizeString(value: string): string {
  const normalizedNewlines = value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r");
  const redactedInternalBlocks = normalizedNewlines
    .replace(INTERNAL_REPLY_TO_MARKER_RE, "")
    .replace(UNTRUSTED_CONTEXT_BLOCK_RE, "")
    .replace(CONVERSATION_INFO_BLOCK_RE, "")
    .replace(SENDER_INFO_BLOCK_RE, "")
    .replace(/\n{3,}/g, "\n\n");
  return redactedInternalBlocks.replace(
    MEDIA_IMAGE_REFERENCE_RE,
    "media:<image-ref>",
  );
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sanitizeValue(value: unknown, seen = new WeakSet()): unknown {
  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular Reference]";
  }

  seen.add(value);
  const originalRef = value;

  try {
    let processableValue = value;

    if (processableValue instanceof Set) {
      processableValue = Array.from(processableValue);
    } else if (processableValue instanceof Map) {
      processableValue = Object.fromEntries(processableValue);
    }

    if (Array.isArray(processableValue)) {
      let changed = false;
      const len = processableValue.length;
      const next = new Array(len);

      for (let idx = 0; idx < len; idx++) {
        const item = processableValue[idx];
        const sanitized = sanitizeValue(item, seen);
        next[idx] = sanitized;
        if (sanitized !== item) changed = true;
      }
      return changed ? next : processableValue;
    }

    if (isPlainObject(processableValue)) {
      let changed = false;
      const next: Record<string, unknown> = {};

      for (const key in processableValue) {
        const child = processableValue[key];
        const sanitized = sanitizeValue(child, seen);
        next[key] = sanitized;
        if (sanitized !== child) changed = true;
      }
      return changed ? next : processableValue;
    }

    return processableValue;
  } finally {
    seen.delete(originalRef);
  }
}
