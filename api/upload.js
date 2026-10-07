import { put } from '@vercel/blob';
import { getRole } from './_lib.js';

const envBy = (suffix) => Object.entries(process.env).find(([k]) => k.endsWith(suffix))?.[1];

export default async function handler(req, res) {
  if (getRole(req) !== 'editor') return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไข' });

  // Blob store แบบใหม่ใช้ <ชื่อ>_STORE_ID (+ OIDC) ส่วนแบบเก่าใช้ *_READ_WRITE_TOKEN รองรับทั้งสองแบบ
  const token = process.env.BLOB_READ_WRITE_TOKEN || envBy('_READ_WRITE_TOKEN');
  const storeId = process.env.BLOB_STORE_ID || envBy('_STORE_ID');
  if (!token && !storeId)
    return res.status(500).json({ error: 'ยังไม่ได้เชื่อม Vercel Blob กับโปรเจกต์นี้ (ไม่พบตัวแปร ..._STORE_ID หรือ BLOB_READ_WRITE_TOKEN)' });

  const m = /^data:image\/jpeg;base64,(.+)$/.exec((req.body || {}).dataUrl || '');
  if (!m) return res.status(400).json({ error: 'ไฟล์รูปไม่ถูกต้อง' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 3e6) return res.status(413).json({ error: 'รูปใหญ่เกินไป' });

  try {
    const blob = await put(`products/${Date.now()}.jpg`, buf, {
      access: 'public',
      contentType: 'image/jpeg',
      ...(token ? { token } : { storeId }),
    });
    res.json({ url: blob.url });
  } catch (e) {
    res.status(500).json({ error: 'อัปโหลดไม่สำเร็จ: ' + (e.message || e) });
  }
}
