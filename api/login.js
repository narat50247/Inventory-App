import { makeToken, safeEq } from './_lib.js';

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const pw = String((req.body || {}).password || '');
  const { EDIT_PASSWORD, VIEW_PASSWORD } = process.env;
  const role = EDIT_PASSWORD && safeEq(pw, EDIT_PASSWORD) ? 'editor'
    : VIEW_PASSWORD && safeEq(pw, VIEW_PASSWORD) ? 'viewer' : null;
  if (!role) return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  res.json({ token: makeToken(role), role });
}
