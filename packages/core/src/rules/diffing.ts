const tokens = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_$]+/)
      .filter(Boolean),
  );

/** Lines that share most of their words: the same line, edited. */
export function similarText(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const union = ta.size + tb.size - shared;
  return union > 0 && shared / union >= 0.5;
}

/**
 * Items of `after` that are genuinely new relative to `before`.
 *
 * Items are first matched by exact `key` (so moved items are not new). Without `similar`, unmatched
 * items count as new only up to the growth of their `group` (so editing a line that already held a
 * suppression does not report it again). With `similar`, an unmatched item is an edit only when an
 * unmatched old item of its group looks like the same line; otherwise it is new, even if the change
 * removed unrelated items of the same group elsewhere (a swap).
 */
export function newItems<T>(
  before: readonly T[],
  after: readonly T[],
  key: (item: T) => string,
  group: (item: T) => string,
  similar?: (a: T, b: T) => boolean,
): T[] {
  const remaining = new Map<string, number>();
  for (const item of before) remaining.set(key(item), (remaining.get(key(item)) ?? 0) + 1);
  const unmatched: T[] = [];
  for (const item of after) {
    const count = remaining.get(key(item)) ?? 0;
    if (count > 0) remaining.set(key(item), count - 1);
    else unmatched.push(item);
  }
  if (similar) {
    const leftover = [...before];
    for (const item of after) {
      if (unmatched.includes(item)) continue;
      const index = leftover.findIndex((b) => key(b) === key(item));
      if (index >= 0) leftover.splice(index, 1);
    }
    return unmatched.filter((item) => {
      const index = leftover.findIndex((b) => group(b) === group(item) && similar(b, item));
      if (index < 0) return true;
      leftover.splice(index, 1);
      return false;
    });
  }
  const growth = new Map<string, number>();
  for (const item of after) growth.set(group(item), (growth.get(group(item)) ?? 0) + 1);
  for (const item of before) growth.set(group(item), (growth.get(group(item)) ?? 0) - 1);
  const result: T[] = [];
  for (const item of unmatched) {
    const left = growth.get(group(item)) ?? 0;
    if (left <= 0) continue;
    growth.set(group(item), left - 1);
    result.push(item);
  }
  return result;
}
