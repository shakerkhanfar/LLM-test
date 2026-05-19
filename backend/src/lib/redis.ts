import IORedis from "ioredis";

// General-purpose Redis client — used for rate limiting, caching, etc.
// NOT for BullMQ: BullMQ requires maxRetriesPerRequest: null (its own connection in evaluationQueue.ts).
// maxRetriesPerRequest: 0 means commands fail immediately if Redis is unreachable,
// allowing callers to fall back gracefully rather than hanging indefinitely.
// lazyConnect: true avoids blocking startup when Redis is temporarily unavailable.
const redis = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 0,
  lazyConnect: true,
  enableOfflineQueue: false, // reject commands immediately when not connected
  retryStrategy: (times) => Math.min(times * 500, 30_000), // cap at 30s between retries
});

redis.on("error", (err) => {
  // Log but don't crash — callers that need Redis have their own fallback logic.
  console.warn("[Redis] Connection error:", err.message);
});

export default redis;
