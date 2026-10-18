// A small, fast, non-cryptographic hash. Identity only needs to be stable and cheap here, not secure -
// used both for deriving stable component/style ids and for detecting whether a capture's content changed.
export function hashString(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
