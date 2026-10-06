import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const sign = (s) => crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update(s).digest('base64url');

export function makeToken(role) {
  const p = role + '.' + (Date.now() + 7 * 864e5);
  return p + '.' + sign(p);
}

export function getRole(req) {
  if (!process.env.SESSION_SECRET) return null;
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const [role, exp, sig] = t.split('.');
  if (!sig || !['editor', 'viewer'].includes(role)) return null;
  if (!safeEq(sig, sign(role + '.' + exp)) || Date.now() > Number(exp)) return null;
  return role;
}
