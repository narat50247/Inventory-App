import { randomUUID } from 'node:crypto';
import { redis, getRole } from './_lib.js';

const fail = (res, code, error, extra = {}) => res.status(code).json({ error, ...extra });
const str = (v, n = 200) => String(v || '').slice(0, n).trim();
const img = (v) => (typeof v === 'string' && v.startsWith('https://') ? v : '');
const name = (p) => [p.type, p.model, p.size].filter(Boolean).join(' ');
const balance = (txs, id) => txs.reduce((n, t) => (t.productId === id ? n + (t.kind === 'in' ? t.qty : -t.qty) : n), 0);
const validTx = (t, p, qty) =>
  p && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && ['in', 'out'].includes(t.kind) && Number.isInteger(qty) && qty >= 1;

export default async function handler(req, res) {
  const role = getRole(req);
  if (!role) return fail(res, 401, 'กรุณาเข้าสู่ระบบ');

  const products = (await redis.get('inv:products')) || [];

  if (req.method === 'GET') {
    const txs = await redis.lrange('inv:tx', 0, -1);
    const options = (await redis.get('inv:options')) || { hiddenSpecs: [] };
    return res.json({ products, txs, options });
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
    if (!validTx(t, p, qty)) return fail(res, 400, 'ข้อมูลไม่ครบหรือไม่ถูกต้อง');
    if (t.kind === 'out' && !body.force) {
      const have = balance(await redis.lrange('inv:tx', 0, -1), p.id);
      if (qty > have) return fail(res, 409, `ยอดคงเหลือไม่พอ (เหลือ ${have})`, { short: true });
    }
    const tx = { id: randomUUID(), date: t.date, kind: t.kind, productId: p.id, qty,
      docNo: str(t.docNo, 60), party: str(t.party), note: str(t.note, 300), image: img(t.image), at: Date.now() };
    await redis.rpush('inv:tx', tx);
    return res.json({ tx });
  }

  if (body.action === 'editTx') {
    const t = body.tx || {};
    const qty = Number(t.qty);
    const p = products.find((x) => x.id === t.productId);
    const all = await redis.lrange('inv:tx', 0, -1);
    const idx = all.findIndex((x) => x.id === t.id);
    if (idx < 0) return fail(res, 404, 'ไม่พบรายการ');
    if (!validTx(t, p, qty)) return fail(res, 400, 'ข้อมูลไม่ครบหรือไม่ถูกต้อง');
    const tx = { ...all[idx], date: t.date, kind: t.kind, productId: p.id, qty,
      docNo: str(t.docNo, 60), party: str(t.party), note: str(t.note, 300), image: img(t.image), editedAt: Date.now() };
    if (!body.force) {
      const next = all.map((x, i) => (i === idx ? tx : x));
      for (const id of new Set([all[idx].productId, p.id])) {
        const left = balance(next, id);
        if (left < 0) return fail(res, 409, `หลังแก้ไข ยอดคงเหลือจะติดลบ (${left})`, { short: true });
      }
    }
    await redis.lset('inv:tx', idx, tx);
    return res.json({ tx });
  }

  if (body.action === 'saveOptions') {
    const o = body.options || {};
    const hiddenSpecs = Array.isArray(o.hiddenSpecs) ? [...new Set(o.hiddenSpecs.map((x) => str(x, 80)).filter(Boolean))].slice(0, 500) : [];
    const cur = (await redis.get('inv:options')) || {};
    const options = { ...cur, hiddenSpecs };
    await redis.set('inv:options', options);
    return res.json({ options });
  }

  if (body.action === 'renameSpec') {
    const from = str(body.from, 80), to = str(body.to, 80);
    if (!from || !to || from === to) return fail(res, 400, 'ชื่อใหม่ไม่ถูกต้อง');
    const specOf = (p) => p.size || p.model;
    const affected = products.filter((p) => specOf(p) === from);
    if (!affected.length) return fail(res, 404, 'ไม่พบสินค้าที่ใช้ชื่อนี้');
    for (const p of affected) {
      if (products.some((x) => x.id !== p.id && x.type === p.type && specOf(x) === to))
        return fail(res, 409, `ประเภท "${p.type}" มี "${to}" อยู่แล้ว จึงเปลี่ยนชื่อไม่ได้ (จะซ้ำกัน)`);
    }
    for (const p of affected) { p.size = to; p.model = to; }
    await redis.set('inv:products', products);
    const cur = (await redis.get('inv:options')) || {};
    const renames = { ...(cur.renames || {}) };
    for (const k of Object.keys(renames)) if (renames[k] === from) renames[k] = to;
    renames[from] = to;
    const hidden = new Set(cur.hiddenSpecs || []);
    hidden.add(from); hidden.delete(to);
    const options = { ...cur, renames, hiddenSpecs: [...hidden] };
    await redis.set('inv:options', options);
    return res.json({ products, options });
  }

  if (body.action === 'syncTx') {
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 20000) : [];
    if (!rows.length) return fail(res, 400, 'ไฟล์ไม่มีรายการข้อมูล');
    const all = await redis.lrange('inv:tx', 0, -1);
    const byId = new Map(all.map((t) => [t.id, t]));
    const byName = new Map(products.map((p) => [name(p), p]));
    const idByKey = {};
    for (const x of Array.isArray(body.newProducts) ? body.newProducts.slice(0, 2000) : []) {
      const spec = str(x.spec, 80) || 'ไม่ระบุ / -';
      const c = { type: str(x.type, 60), model: spec, size: spec };
      if (!c.type) return fail(res, 400, 'มีรายการที่ไม่ระบุหมวดสินค้า');
      let p = byName.get(name(c));
      if (!p) { p = { id: randomUUID(), ...c, min: 0, image: '' }; products.push(p); byName.set(name(c), p); }
      idByKey[x.key] = p.id;
    }
    const valid = new Set(products.map((p) => p.id));
    const FIELDS = ['date', 'kind', 'productId', 'qty', 'docNo', 'party', 'note', 'image'];
    const used = new Set(), out = [], now = Date.now();
    for (const [i, r] of rows.entries()) {
      const qty = Number(r.qty), pid = r.productId || idByKey[r.key];
      if (!valid.has(pid) || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !['in', 'out'].includes(r.kind) || !Number.isInteger(qty) || qty < 1)
        return fail(res, 400, 'ข้อมูลบางแถวไม่ถูกต้อง ไม่มีการเปลี่ยนแปลงใดๆ');
      const data = { date: r.date, kind: r.kind, productId: pid, qty, docNo: str(r.docNo, 60), party: str(r.party), note: str(r.note, 300), image: img(r.image) };
      const old = r.id && !used.has(r.id) ? byId.get(r.id) : null;
      if (old) {
        used.add(old.id);
        out.push(FIELDS.every((k) => (old[k] ?? '') === data[k]) ? old : { ...old, ...data, editedAt: now });
      } else out.push({ id: randomUUID(), ...data, at: now + i });
    }
    const final = [...(body.deleteMissing ? [] : all.filter((t) => !used.has(t.id))), ...out];
    const tmp = 'inv:tx:new';
    await redis.del(tmp);
    for (let i = 0; i < final.length; i += 500) await redis.rpush(tmp, ...final.slice(i, i + 500));
    try {
      if (all.length) await redis.rename('inv:tx', 'inv:tx:backup');   // สำรองข้อมูลเดิม 1 ชุดล่าสุด
      await redis.rename(tmp, 'inv:tx');
    } catch (e) {
      if (all.length) await redis.rename('inv:tx:backup', 'inv:tx').catch(() => {});
      return fail(res, 500, 'บันทึกไม่สำเร็จ: ' + (e.message || e));
    }
    await redis.set('inv:products', products);
    return res.json({ products, txs: final });
  }

  if (body.action === 'addTxs') {
    const list = Array.isArray(body.txs) ? body.txs.slice(0, 200) : [];
    if (!list.length) return fail(res, 400, 'ไม่มีรายการให้บันทึก');
    const bal = new Map();
    for (const t of await redis.lrange('inv:tx', 0, -1)) bal.set(t.productId, (bal.get(t.productId) || 0) + (t.kind === 'in' ? t.qty : -t.qty));
    const out = [], short = [], now = Date.now();
    for (const [i, t] of list.entries()) {
      const qty = Number(t.qty), p = products.find((x) => x.id === t.productId);
      if (!validTx(t, p, qty)) return fail(res, 400, `รายการที่ ${i + 1} ข้อมูลไม่ครบหรือไม่ถูกต้อง ไม่มีการบันทึกใดๆ`);
      const cur = bal.get(p.id) || 0, next = cur + (t.kind === 'in' ? qty : -qty);
      if (t.kind === 'out' && next < 0) short.push(`${[p.type, p.size || p.model].filter(Boolean).join(' ')} (เหลือ ${cur}, จ่าย ${qty})`);
      bal.set(p.id, next);
      out.push({ id: randomUUID(), date: t.date, kind: t.kind, productId: p.id, qty,
        docNo: str(t.docNo, 60), party: str(t.party), note: str(t.note, 300), image: img(t.image), at: now + i });
    }
    if (short.length && !body.force) return fail(res, 409, 'ยอดคงเหลือไม่พอ: ' + short.join(', '), { short: true });
    await redis.rpush('inv:tx', ...out);
    return res.json({ txs: out });
  }

  if (body.action === 'deleteTx') {
    const all = await redis.lrange('inv:tx', 0, -1);
    const found = all.find((t) => t.id === body.id);
    if (!found) return fail(res, 404, 'ไม่พบรายการ');
    await redis.lrem('inv:tx', 1, found);
    return res.json({ ok: true });
  }

  if (body.action === 'bulkImport') {
    const existing = await redis.lrange('inv:tx', 0, -1);
    if (existing.length && !body.force) return fail(res, 409, 'ในระบบมีรายการรับ-จ่ายอยู่แล้ว', { exists: true });
    const inP = Array.isArray(body.products) ? body.products.slice(0, 2000) : [];
    const inTx = Array.isArray(body.txs) ? body.txs.slice(0, 20000) : [];
    const byName = new Map(products.map((p) => [name(p), p]));
    const idByKey = {};
    for (const x of inP) {
      const c = { type: str(x.type, 60), model: str(x.model, 80), size: str(x.size, 40) };
      if (!c.type) return fail(res, 400, `สินค้า "${str(x.key)}" ยังไม่ระบุประเภท`);
      let p = byName.get(name(c));
      if (!p) { p = { id: randomUUID(), ...c, min: 0, image: '' }; products.push(p); byName.set(name(c), p); }
      idByKey[x.key] = p.id;
    }
    const rows = [];
    for (const t of inTx) {
      const qty = Number(t.qty), pid = idByKey[t.key];
      if (!pid || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || !['in', 'out'].includes(t.kind) || !Number.isInteger(qty) || qty < 1)
        return fail(res, 400, 'ข้อมูลบางแถวไม่ถูกต้อง');
      rows.push({ id: randomUUID(), date: t.date, kind: t.kind, productId: pid, qty,
        docNo: str(t.docNo, 60), party: str(t.party), note: str(t.note, 300), at: Date.now() });
    }
    await redis.set('inv:products', products);
    for (let i = 0; i < rows.length; i += 500) await redis.rpush('inv:tx', ...rows.slice(i, i + 500));
    return res.json({ products: products.length, txs: rows.length });
  }

  return fail(res, 400, 'คำสั่งไม่ถูกต้อง');
}
