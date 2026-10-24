/**
 * Looks up a client-supplied key in a constant map. Only the map's OWN keys count: a plain object
 * also "has" `constructor`, `__proto__`, `toString` … through its prototype, which turned
 * `?sort=__proto__` into a server error. Returns undefined for anything that is not an own key.
 */
export function ownEntry<T extends object>(map: T, key: string): T[keyof T] | undefined {
  return Object.hasOwn(map, key) ? map[key as keyof T] : undefined;
}

/** Escapes LIKE/ILIKE wildcards (and the backslash escape itself) in a user-supplied search term. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
