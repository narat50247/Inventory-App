import { put } from '@vercel/blob';
import { getRole } from './_lib.js';

export default async function handler(req, res) {
  if (getRole(req) !== 'editor') return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไข' });

  // รองรับทั้งชื่อมาตรฐาน BLOB_READ_WRITE_TOKEN และชื่อที่ Vercel ตั้งให้ตอนเชื่อมหลาย store (…_READ_WRITE_TOKEN)
  const token = process.env.BLOB_READ_WRITE_TOKEN ||
    Object.entries(process.env).find(([k]) => k.endsWith('_READ_WRITE_TOKEN'))?.[1];
  if (!token) return res.status(500).json({ error: 'ยังไม่ได้เชื่อม Vercel Blob กับโปรเจกต์นี้ (ไม่พบ BLOB_READ_WRITE_TOKEN)' });

  const m = /^data:image\/jpeg;base64,(.+)$/.exec((req.body || {}).dataUrl || '');
  if (!m) return res.status(400).json({ error: 'ไฟล์รูปไม่ถูกต้อง' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 3e6) return res.status(413).json({ error: 'รูปใหญ่เกินไป' });

  try {
    const blob = await put(`products/${Date.now()}.jpg`, buf, { access: 'public', contentType: 'image/jpeg', token });
    res.json({ url: blob.url });
  } catch (e) {
    res.status(500).json({ error: 'อัปโหลดไม่สำเร็จ: ' + (e.message || e) });
  }
}
