/** Narrowing helpers for parsed JSON (JSON.parse returns any; keep it unknown until checked). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Array.isArray narrows to any[]; this keeps the elements unknown. */
export const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
