export const PUBLIC_ROUND_LIMITS = {
  mode: 'onchain' as const,
  duration: 60,
  dailyLimit: 12,
  cooldownMs: 60_000,
};

export interface PublicUsage {
  day: string;
  attempts: number;
  lastAttempt: number;
}

export class PublicAccessError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAt?: number,
  ) {
    super(message);
  }
}

export function publicRoundStatus(usage?: PublicUsage, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const used = usage?.day === day ? usage.attempts : 0;
  const remaining = Math.max(0, PUBLIC_ROUND_LIMITS.dailyLimit - used);
  const nextDay = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
  const cooldown = usage ? usage.lastAttempt + PUBLIC_ROUND_LIMITS.cooldownMs : 0;
  const retryAt = remaining === 0 ? Math.max(nextDay, cooldown) : cooldown > now ? cooldown : null;
  return { ...PUBLIC_ROUND_LIMITS, remaining, retryAt };
}

export function reservePublicRound(
  input: { mode: string; duration: number },
  usage: PublicUsage | undefined,
  active: boolean,
  enabled: boolean,
  now = Date.now(),
): PublicUsage {
  if (input.mode !== PUBLIC_ROUND_LIMITS.mode || input.duration !== PUBLIC_ROUND_LIMITS.duration) {
    throw new PublicAccessError(
      'Public rounds use On-chain AI with a one-minute observation.',
      403,
    );
  }
  if (!enabled) throw new PublicAccessError('Public AI rounds are not available yet.', 503);
  if (active)
    throw new PublicAccessError('A round is already running. You can follow it in the arena.', 409);
  const status = publicRoundStatus(usage, now);
  if (!status.remaining)
    throw new PublicAccessError(
      'The daily public round limit has been reached. It resets at midnight UTC.',
      429,
      status.retryAt!,
    );
  if (status.retryAt)
    throw new PublicAccessError(
      'Please wait for the public round cooldown to finish.',
      429,
      status.retryAt,
    );
  const day = new Date(now).toISOString().slice(0, 10);
  return { day, attempts: (usage?.day === day ? usage.attempts : 0) + 1, lastAttempt: now };
}

export async function readRoundJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new PublicAccessError('Round details are required.', 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) {
        await reader.cancel();
        throw new PublicAccessError('Round request is too large.', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PublicAccessError('Invalid round details.', 400);
  }
}
