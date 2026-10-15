export const EXIT = { ok: 0, violations: 1, toolError: 3 } as const;

/** An expected failure with a user-facing message (exit 3, no stack trace). */
export class UsageError extends Error {
  override readonly name = "UsageError";
}
