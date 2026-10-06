import { put } from '@vercel/blob';
import { getRole } from './_lib.js';

export default async function handler(req, res) {
  if (getRole(req) !== 'editor') return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไข' });
  const m = /^data:image\/jpeg;base64,(.+)$/.exec((req.body || {}).dataUrl || '');
  if (!m) return res.status(400).json({ error: 'ไฟล์รูปไม่ถูกต้อง' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 3e6) return res.status(413).json({ error: 'รูปใหญ่เกินไป' });
  const blob = await put(`products/${Date.now()}.jpg`, buf, { access: 'public', contentType: 'image/jpeg' });
  res.json({ url: blob.url });
}
