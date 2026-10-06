import { randomUUID } from 'node:crypto';
import { redis, getRole } from './_lib.js';

const fail = (res, code, error, extra = {}) => res.status(code).json({ error, ...extra });
const str = (v, n = 200) => String(v || '').slice(0, n).trim();
const name = (p) => [p.type, p.model, p.size].filter(Boolean).join(' ');
const balance = (txs, id) => txs.reduce((n, t) => (t.productId === id ? n + (t.kind === 'in' ? t.qty : -t.qty) : n), 0);

export default async function handler(req, res) {
  const role = getRole(req);
  if (!role) return fail(res, 401, 'กรุณาเข้าสู่ระบบ');

  const products = (await redis.get('inv:products')) || [];

  if (req.method === 'GET') {
    const txs = await redis.lrange('inv:tx', 0, -1);
    return res.json({ products, txs });
  }

  if (role !== 'editor') return fail(res, 403, 'บัญชีนี้ดูได้อย่างเดียว');
  const body = req.body || {};

  if (body.action === 'saveProduct') {
    const p = body.product || {};
    const clean = {
      id: p.id || randomUUID(),
      type: str(p.type, 60), model: str(p.model, 80), size: str(p.size, 40),
      min: Math.max(0, parseInt(p.min) || 0),
      image: typeof p.image === 'string' && p.image.startsWith('https://') ? p.image : '',
    };
    if (!clean.type) return fail(res, 400, 'กรุณาระบุประเภทสินค้า');
    if (products.some((x) => x.id !== clean.id && name(x) === name(clean))) return fail(res, 409, 'มีรายการนี้อยู่แล้ว');
    const i = products.findIndex((x) => x.id === clean.id);
    if (i < 0) products.push(clean); else products[i] = clean;
    await redis.set('inv:products', products);
    return res.json({ product: clean });
  }

  if (body.action === 'deleteProduct') {
    const txs = await redis.lrange('inv:tx', 0, -1);
    if (txs.some((t) => t.productId === body.id)) return fail(res, 409, 'มีประวัติรับ-จ่ายแล้ว ลบไม่ได้');
    await redis.set('inv:products', products.filter((x) => x.id !== body.id));
    return res.json({ ok: true });
  }

  if (body.action === 'addTx') {
    const t = body.tx || {};
    const qty = Number(t.qty);
    const p = products.find((x) => x.id === t.productId);
    if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || !['in', 'out'].includes(t.kind) || !Number.isInteger(qty) || qty < 1)
      return fail(res, 400, 'ข้อมูลไม่ครบหรือไม่ถูกต้อง');
    if (t.kind === 'out' && !body.force) {
      const have = balance(await redis.lrange('inv:tx', 0, -1), p.id);
      if (qty > have) return fail(res, 409, `ยอดคงเหลือไม่พอ (เหลือ ${have})`, { short: true });
    }
    const tx = { id: randomUUID(), date: t.date, kind: t.kind, productId: p.id, qty,
      docNo: str(t.docNo, 60), party: str(t.party), note: str(t.note, 300), at: Date.now() };
    await redis.rpush('inv:tx', tx);
    return res.json({ tx });
  }

  if (body.action === 'deleteTx') {
    const all = await redis.lrange('inv:tx', 0, -1);
    const found = all.find((t) => t.id === body.id);
    if (!found) return fail(res, 404, 'ไม่พบรายการ');
    await redis.lrem('inv:tx', 1, found);
    return res.json({ ok: true });
  }

  return fail(res, 400, 'คำสั่งไม่ถูกต้อง');
}
