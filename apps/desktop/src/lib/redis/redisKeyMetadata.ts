/**
 * The key browser fills the TYPE badge and the expiry countdown of the rows
 * it lists. A scan can ask the server for that metadata inline, which costs
 * two commands per key, so the sweep only does it for a bounded number of
 * keys and the rest is resolved afterwards.
 */

/**
 * Keys a single sweep may pay for inline TYPE/TTL metadata.
 *
 * The sweep asks Redis for COUNT = 50 000 keys per round trip, so one batch
 * already costs at most 2 * 50 000 commands. The budget keeps a whole sweep at
 * that order of magnitude no matter how large the keyspace is: the keys
 * beyond it are listed by name and their badges are filled in afterwards, for
 * the rows the user actually looks at.
 */
export const REDIS_FETCH_ALL_INLINE_METADATA_MAX_KEYS = 50_000;

/**
 * Whether the sweep may keep asking for inline TYPE/TTL metadata.
 *
 * `inlineKeys` counts the keys the sweep already asked the server about, so
 * the decision never depends on a DBSIZE that may be stale, may be missing
 * (kvrocks only counts asynchronously) or that describes the whole database
 * instead of the filtered scope being swept.
 */
export function redisFetchAllShouldInlineMetadata(inlineKeys: number, budget = REDIS_FETCH_ALL_INLINE_METADATA_MAX_KEYS): boolean {
  return inlineKeys < budget;
}

/**
 * Keys that may wait for their metadata.
 *
 * The visible window can queue faster than the backend answers, so the queue
 * is capped: it holds the rows the user is looking at, not every key of a
 * million-key database.
 */
export const REDIS_METADATA_BACKFILL_QUEUE_LIMIT = 5_000;

/**
 * Drops the oldest queued keys once the queue grows past its limit.
 *
 * The oldest entries belong to the rows the user scrolled past; their badges
 * are filled in again when they are listed anew. The queue keeps its
 * insertion order, so the first key is the oldest one.
 */
export function trimRedisMetadataBackfillQueue(queue: Set<string>, limit = REDIS_METADATA_BACKFILL_QUEUE_LIMIT): void {
  while (queue.size > limit) {
    const oldest = queue.values().next().value;
    if (oldest === undefined) break;
    queue.delete(oldest);
  }
}
