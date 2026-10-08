import { redis, getRole } from './_lib.js';

export const config = { maxDuration: 60 };

const fail = (res, code, error) => res.status(code).json({ error });
const str = (v, n = 200) => String(v || '').slice(0, n).trim();
const today = () => new Date(Date.now() + 7 * 36e5).toISOString().slice(0, 10);
const spec = (p) => { const s = p.size || p.model || ''; return s === 'ไม่ระบุ / -' ? '' : s; };
const sorted = (products) => [...products].sort((a, b) => (a.type + spec(a)).localeCompare(b.type + spec(b), 'th', { numeric: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// เรียกโมเดลแบบ OpenAI-compatible (/chat/completions)
// timeout = เวลารวมสูงสุดของขั้นนี้ (วินาที), label = ชื่อขั้นตอน ใช้แสดงในข้อความผิดพลาด
async function chat({ base, key, model }, messages, { max = 2000, timeout = 50, label = 'AI', extra = {} } = {}) {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    const left = Math.max(5, timeout - (Date.now() - t0) / 1000);
    let r;
    try {
      r = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: max, ...extra }),
        signal: AbortSignal.timeout(left * 1000),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError')
        throw new Error(`${label} ใช้เวลานานเกิน ${timeout} วินาที (ผู้ให้บริการอาจช้าหรือติดโควตา) กรุณาลองใหม่อีกครั้ง`);
      throw new Error(`${label}: เชื่อมต่อไม่สำเร็จ (${e.message})`);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if ([429, 502, 503, 504].includes(r.status) && attempt === 0 && Date.now() - t0 < 15000) { await sleep(2000); continue; }
      const e0 = Array.isArray(j) ? j[0] : j;   // Google ตอบ error เป็น array ในบางกรณี
      const why = String(e0?.error?.message || (typeof e0?.error === 'string' ? e0.error : '') || e0?.message || `รหัส ${r.status}`).slice(0, 200);
      throw new Error(`${label}: ผู้ให้บริการตอบกลับผิดพลาด (รหัส ${r.status}: ${why}) [โมเดล: ${model}]`);
    }
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error(`${label}: AI ไม่ได้ส่งคำตอบกลับมา`);
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
}

function extractJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('AI ตอบกลับในรูปแบบที่อ่านไม่ได้ ลองใหม่อีกครั้ง หรือแบ่งข้อความให้สั้นลง');
  try { return JSON.parse(text.slice(a, b + 1)); }
  catch { throw new Error('AI ตอบกลับในรูปแบบที่อ่านไม่ได้ ลองใหม่อีกครั้ง หรือแบ่งข้อความให้สั้นลง'); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const role = getRole(req);
  if (!role) return fail(res, 401, 'กรุณาเข้าสู่ระบบ');

  const { AI_BASE_URL, AI_API_KEY, AI_MODEL, AI_VISION_BASE_URL, AI_VISION_API_KEY, AI_VISION_MODEL } = process.env;
  if (!AI_BASE_URL || !AI_API_KEY || !AI_MODEL)
    return fail(res, 500, 'ยังไม่ได้ตั้งค่า AI (ต้องมี AI_BASE_URL, AI_API_KEY, AI_MODEL ใน Vercel Environment Variables)');
  const text = { base: AI_BASE_URL, key: AI_API_KEY, model: AI_MODEL };
  const body = req.body || {};
  const products = (await redis.get('inv:products')) || [];

  try {
    // ---------- ถามยอดคงเหลือ (ตัวเลขคำนวณโดยโค้ด ไม่ให้ AI คิดเอง) ----------
    if (body.action === 'ask') {
      const question = str(body.question, 500);
      if (!question) return fail(res, 400, 'กรุณาพิมพ์คำถาม');
      const txs = await redis.lrange('inv:tx', 0, -1);
      const bal = {};
      txs.forEach((t) => { bal[t.productId] = (bal[t.productId] || 0) + (t.kind === 'in' ? t.qty : -t.qty); });
      const totals = {};
      const lines = sorted(products).map((p) => {
        const n = bal[p.id] || 0;
        totals[p.type] = (totals[p.type] || 0) + n;
        return `${p.type} | ${spec(p) || '-'} | ${n}`;
      });
      const table = `ประเภท | size/แบบ | คงเหลือ\n${lines.join('\n')}\n\nยอดรวมแต่ละประเภท:\n${Object.entries(totals).map(([k, v]) => `${k} = ${v}`).join('\n')}`;
      const answer = await chat(text, [
        { role: 'system', content: `คุณเป็นผู้ช่วยตอบคำถามเรื่องยอดสินค้าคงเหลือของคลังสินค้า ตอบเป็นภาษาไทย สั้น กระชับ
- ใช้ข้อมูลในตารางด้านล่างเท่านั้น ห้ามเดาตัวเลข ถ้าต้องรวมเลขให้ใช้ยอดรวมที่ให้ไว้ หรือบวกอย่างระมัดระวัง
- ถ้าผู้ใช้ถามไม่ระบุ size/แบบ ให้ตอบทุกรายการที่ตรงเป็นข้อๆ
- ถ้าไม่พบสินค้าตามที่ถาม ให้บอกว่าไม่พบ และเสนอรายการใกล้เคียงจากตาราง
- ตอบได้เฉพาะยอดคงเหลือปัจจุบัน ถ้าถามเรื่องประวัติรับ-จ่าย ให้บอกว่าตอบไม่ได้และแนะนำให้ดูแท็บ รับเข้า/จ่ายออก

ตารางสินค้าคงเหลือ:
${table}` },
        { role: 'user', content: question },
      ], { max: 800, timeout: 50, label: 'โมเดลข้อความ' });
      return res.json({ answer });
    }

    // ---------- ขั้นที่ 1 (เฉพาะรูป): อ่านข้อความจากรูปใบส่งของ ----------
    if (body.action === 'ocr') {
      if (role !== 'editor') return fail(res, 403, 'บัญชีนี้ดูได้อย่างเดียว');
      if (!AI_VISION_MODEL) return fail(res, 500, 'ยังไม่ได้ตั้งค่าโมเดลอ่านรูป (ต้องมี AI_VISION_MODEL ใน Vercel Environment Variables)');
      if (!/^data:image\/jpeg;base64,/.test(body.image || '') || body.image.length > 3.5e6) return fail(res, 400, 'ไฟล์รูปไม่ถูกต้อง หรือใหญ่เกินไป');
      const ocr = await chat({ base: AI_VISION_BASE_URL || AI_BASE_URL, key: AI_VISION_API_KEY || AI_API_KEY, model: AI_VISION_MODEL }, [{
        role: 'user',
        content: [
          { type: 'text', text: 'อ่านข้อความทั้งหมดในภาพเอกสารนี้ให้ครบและตรงตามต้นฉบับ รวมถึงตัวเลข วันที่ เลขที่เอกสาร ชื่อหน่วยงาน และรายการในตาราง (ตารางให้เขียนแถวละบรรทัด คั่นคอลัมน์ด้วย |) ห้ามสรุปหรือเดาตัวเลข ถ้าอ่านไม่ออกให้เขียนว่า [อ่านไม่ออก]' },
          { type: 'image_url', image_url: { url: body.image } },
        ],
      }], { max: 6000, timeout: 45, label: 'ขั้นอ่านรูป (โมเดลรูปภาพ)', extra: process.env.AI_VISION_REASONING_EFFORT ? { reasoning_effort: process.env.AI_VISION_REASONING_EFFORT } : {} });
      return res.json({ ocr });
    }

    // ---------- ขั้นที่ 2: แยกรายการรับ/จ่ายจากข้อความ (พิมพ์เอง หรือข้อความที่อ่านจากรูป) ----------
    if (body.action === 'parse') {
      if (role !== 'editor') return fail(res, 403, 'บัญชีนี้ดูได้อย่างเดียว');
      const source = str(body.text, 8000);
      if (!source) return fail(res, 400, 'ไม่มีข้อความให้แยกรายการ');

      const sortedP = sorted(products);
      const byNo = new Map(sortedP.map((p, i) => [i + 1, p]));
      const list = sortedP.map((p, i) => `#${i + 1} | ${p.type} | ${spec(p) || '-'}`).join('\n');
      const out = await chat(text, [
        { role: 'system', content: `คุณแปลงข้อความ (หรือข้อความที่อ่านจากใบส่งของ/ใบจ่ายของ) เป็นรายการรับเข้า/จ่ายออกของคลังสินค้า
วันนี้คือ ${today()} (ค.ศ.) เอกสารไทยมักใช้ปี พ.ศ. ให้แปลงเป็น ค.ศ. (ลบ 543)
กติกา:
- kind: "in" = รับเข้า (รับ, ได้รับ, รับจาก, นำเข้า) / "out" = จ่ายออก (จ่าย, ส่ง, เบิก, แจก, มอบ)
- product_no ต้องเลือกจากรายการสินค้าด้านล่างเท่านั้น ถ้าไม่แน่ใจหรือไม่มีในรายการให้ใส่ null ห้ามเดา
- qty เป็นจำนวนเต็มบวกตามที่ปรากฏในข้อความ ห้ามคำนวณหรือเดาเอง ถ้าอ่านจำนวนไม่ได้ให้ข้ามรายการนั้นและแจ้งใน warnings
- doc_no = เลขที่เอกสาร/ใบส่งของ, party = ผู้ส่ง/ผู้รับ/หน่วยงาน, note = ข้อมูลอื่นที่เกี่ยวข้อง
- date รูปแบบ YYYY-MM-DD ถ้าไม่ระบุให้เป็น null
- source = ข้อความต้นฉบับสั้นๆ ที่ใช้สร้างรายการนั้น
ตอบเป็น JSON เท่านั้น ไม่มีข้อความอื่น รูปแบบ:
{"rows":[{"date":"YYYY-MM-DD หรือ null","kind":"in หรือ out","product_no":ตัวเลข หรือ null,"qty":ตัวเลข,"doc_no":"","party":"","note":"","source":""}],"warnings":["..."]}

รายการสินค้า (#เลข | ประเภท | size/แบบ):
${list}` },
        { role: 'user', content: source },
      ], { max: 3000, timeout: 50, label: 'ขั้นแยกรายการ (โมเดลข้อความ)' });

      const j = extractJson(out);
      const warnings = (Array.isArray(j.warnings) ? j.warnings : []).map((w) => str(w, 300)).filter(Boolean);
      const rows = [];
      for (const r of (Array.isArray(j.rows) ? j.rows : []).slice(0, 100)) {
        const qty = Number(r.qty), kind = r.kind === 'in' || r.kind === 'out' ? r.kind : '';
        if (!kind || !Number.isInteger(qty) || qty < 1) { warnings.push(`ข้ามรายการที่อ่านไม่ได้: ${str(r.source, 120) || '(ไม่มีต้นฉบับ)'}`); continue; }
        let date = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : '';
        if (date && +date.slice(0, 4) > 2400) date = `${+date.slice(0, 4) - 543}${date.slice(4)}`;
        const p = byNo.get(Number(r.product_no));
        rows.push({ date, kind, productId: p ? p.id : '', qty, docNo: str(r.doc_no, 60), party: str(r.party), note: str(r.note, 300), source: str(r.source, 200) });
      }
      if (!rows.length) warnings.push('AI ไม่พบรายการที่นำมาบันทึกได้ ลองเขียนข้อความให้ชัดเจนขึ้น');
      return res.json({ rows, warnings });
    }
  } catch (e) {
    return fail(res, 502, e.message || 'เรียก AI ไม่สำเร็จ');
  }
  return fail(res, 400, 'คำสั่งไม่ถูกต้อง');
}
