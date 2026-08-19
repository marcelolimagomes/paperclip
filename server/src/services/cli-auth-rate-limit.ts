export const CLI_AUTH_CHALLENGE_RATE_LIMIT_WINDOW_MS = 60_000;
export const CLI_AUTH_CHALLENGE_RATE_LIMIT_MAX_REQUESTS = 5;

export type CliAuthRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export type CliAuthRateLimiter = {
  consume(clientIp: string): CliAuthRateLimitResult;
};

export function createCliAuthRateLimiter(options: {
  windowMs?: number;
  maxRequests?: number;
  now?: () => number;
} = {}): CliAuthRateLimiter {
  const windowMs = options.windowMs ?? CLI_AUTH_CHALLENGE_RATE_LIMIT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? CLI_AUTH_CHALLENGE_RATE_LIMIT_MAX_REQUESTS;
  const now = options.now ?? Date.now;
  const hitsByIp = new Map<string, number[]>();

  return {
    consume(clientIp) {
      const currentTime = now();
      const cutoff = currentTime - windowMs;
      const key = clientIp.trim() || "unknown";
      const recentHits = (hitsByIp.get(key) ?? []).filter((hit) => hit > cutoff);

      if (recentHits.length >= maxRequests) {
        const oldestHit = recentHits[0] ?? currentTime;
        hitsByIp.set(key, recentHits);
        return {
          allowed: false,
          limit: maxRequests,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((oldestHit + windowMs - currentTime) / 1000)),
        };
      }

      recentHits.push(currentTime);
      hitsByIp.set(key, recentHits);
      return {
        allowed: true,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - recentHits.length),
        retryAfterSeconds: 0,
      };
    },
  };
}
