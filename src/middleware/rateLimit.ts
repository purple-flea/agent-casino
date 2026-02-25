/**
 * Simple in-memory rate limiter (per agentId)
 * Limits: 30 bets/min on individual games, 10/min on batch
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const limits = new Map<string, RateLimitEntry>();

function cleanupOld() {
  const now = Date.now();
  for (const [key, entry] of limits) {
    if (now > entry.resetAt) limits.delete(key);
  }
}

export function checkRateLimit(
  agentId: string,
  bucket: string,
  maxPerMinute: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const key = `${agentId}:${bucket}`;
  const now = Date.now();
  const windowMs = 60_000;

  // Cleanup every 500 calls
  if (limits.size > 500) cleanupOld();

  let entry = limits.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    limits.set(key, entry);
  }

  entry.count++;
  const remaining = Math.max(0, maxPerMinute - entry.count);
  const allowed = entry.count <= maxPerMinute;

  return { allowed, remaining, resetAt: entry.resetAt };
}
