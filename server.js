import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, 'data');
const logsDir = path.join(dataDir, 'logs');
const rawDir = path.join(dataDir, 'raw');
const normalizedDir = path.join(dataDir, 'normalized');
const statePath = path.join(dataDir, 'state.json');
const configPath = path.join(__dirname, 'config.json');
const configExamplePath = path.join(__dirname, 'config.example.json');
const rulesPath = path.join(__dirname, 'classification-rules.json');
const accountsPath = path.join(__dirname, 'accounts-registry.json');

for (const dir of [dataDir, logsDir, rawDir, normalizedDir]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(configPath)) fs.copyFileSync(configExamplePath, configPath);
if (!fs.existsSync(statePath)) fs.writeFileSync(statePath, JSON.stringify({ seenDedupeKeys: [], daily: {} }, null, 2));

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8')).filter(r => r.active).sort((a,b) => a.priority - b.priority);
const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));

function readState() { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
function writeState(state) { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); }
function nowIso() { return new Date().toISOString(); }
function logLine(message, obj) {
  const line = `[${nowIso()}] ${message}${obj ? ' ' + JSON.stringify(obj) : ''}\n`;
  fs.appendFileSync(path.join(logsDir, 'server.log'), line);
  console.log(line.trim());
}
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function normalizeText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
function getTextFields(obj, prefix = '') {
  const out = [];
  if (obj == null) return out;
  if (typeof obj === 'string' || typeof obj === 'number') {
    out.push(String(obj));
    return out;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) out.push(...getTextFields(item));
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) out.push(...getTextFields(v, `${prefix}${k}.`));
  }
  return out;
}
function pick(payload, candidates, fallback = '') {
  for (const key of candidates) {
    const parts = key.split('.');
    let cur = payload;
    let found = true;
    for (const p of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
      else { found = false; break; }
    }
    if (found && cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return fallback;
}
function inferDirection(payload, amount, text) {
  const hint = normalizeText(`${pick(payload,['type','transferType','transactionType','gateway'])} ${pick(payload,['description','content','transferContent'])}`);
  if (hint.includes('hoan tien') || hint.includes('refund')) return 'refund';
  if (hint.includes('chuyen noi bo') || hint.includes('noi bo')) return 'transfer_internal';
  if (hint.includes('chi') || hint.includes('tru tien') || hint.includes('thanh toan')) return 'expense';
  if (hint.includes('nhan') || hint.includes('co tien vao') || hint.includes('tang')) return 'income';
  if (Number(amount) >= 0) return 'income';
  return 'expense';
}
function matchRule(text) {
  for (const rule of rules) {
    const pattern = rule.pattern;
    if (rule.matchType === 'contains' && text.includes(normalizeText(pattern))) return rule;
    if (rule.matchType === 'containsAny' && Array.isArray(pattern) && pattern.some(p => text.includes(normalizeText(p)))) return rule;
  }
  return null;
}
function isInternalTransfer(text) {
  if (text.includes('noi bo')) return true;
  return accounts.some(acc => acc.active && acc.accountMasked && text.includes(normalizeText(acc.accountMasked)));
}
function deriveMetrics(direction, amount) {
  const abs = Math.abs(Number(amount || 0));
  switch (direction) {
    case 'expense': return { gross_outflow: abs, net_effect: -abs, effective_spending: abs };
    case 'income': return { gross_outflow: 0, net_effect: abs, effective_spending: 0 };
    case 'refund': return { gross_outflow: 0, net_effect: abs, effective_spending: -abs };
    case 'transfer_internal': return { gross_outflow: abs, net_effect: 0, effective_spending: 0 };
    default: return { gross_outflow: 0, net_effect: 0, effective_spending: 0 };
  }
}
function summarizeToday(state, dayKey) {
  const day = state.daily[dayKey] || { income: 0, expense: 0, effective_spending: 0, count: 0 };
  return day;
}
function updateDaily(state, tx) {
  const key = tx.day_key;
  if (!state.daily[key]) state.daily[key] = { income: 0, expense: 0, effective_spending: 0, count: 0 };
  const day = state.daily[key];
  if (tx.direction === 'income' || tx.direction === 'refund') day.income += Math.max(0, tx.net_effect);
  if (tx.direction === 'expense' || tx.direction === 'transfer_internal') day.expense += tx.gross_outflow;
  day.effective_spending += tx.effective_spending;
  day.count += 1;
}
function buildNotification(tx, state) {
  const day = summarizeToday(state, tx.day_key);
  const amountFmt = new Intl.NumberFormat('vi-VN').format(Math.abs(tx.amount));
  const todayFmt = new Intl.NumberFormat('vi-VN').format(Math.abs(day.effective_spending));
  if (tx.direction === 'income' || tx.direction === 'refund') {
    return `Giao dịch mới\n- ${tx.direction === 'refund' ? 'Hoàn tiền' : 'Nhận tiền'}: ${amountFmt}đ\n- Nhóm: ${tx.category} > ${tx.subcategory}\n- Nội dung: ${tx.normalized_description}\n- Hôm nay chi tiêu thực: ${todayFmt}đ`;
  }
  return `Giao dịch mới\n- Vừa chi: ${amountFmt}đ\n- Nhóm: ${tx.category} > ${tx.subcategory}\n- Nội dung: ${tx.normalized_description}\n- Hôm nay đã chi thực: ${todayFmt}đ`;
}
function buildDedupeKey(payload) {
  const seed = JSON.stringify({
    id: pick(payload,['id','transaction_id','transactionId','reference','refNo','code']),
    amount: pick(payload,['amount','transferAmount','money']),
    time: pick(payload,['transactionDate','transaction_time','created_at','createdAt']),
    description: pick(payload,['description','content','transferContent'])
  });
  return crypto.createHash('sha256').update(seed).digest('hex');
}
function normalizePayload(payload) {
  const received_at = nowIso();
  const amountRaw = Number(pick(payload,['amount','transferAmount','money','value'],0));
  const text = getTextFields(payload).join(' | ');
  const normalizedText = normalizeText(text);
  const rule = matchRule(normalizedText);
  let direction = inferDirection(payload, amountRaw, normalizedText);
  if (isInternalTransfer(normalizedText)) direction = 'transfer_internal';
  if (rule?.directionHint && direction === 'unknown') direction = rule.directionHint;
  const metrics = deriveMetrics(direction, amountRaw);
  const transaction_time = pick(payload,['transactionDate','transaction_time','created_at','createdAt'], received_at);
  const day = new Date(transaction_time);
  const yyyy = day.getFullYear();
  const mm = String(day.getMonth()+1).padStart(2,'0');
  const dd = String(day.getDate()).padStart(2,'0');
  const event_id = pick(payload,['id','transaction_id','transactionId','reference','refNo'], `evt_${Date.now()}`);
  const tx = {
    event_id,
    source_event_id: event_id,
    dedupe_key: buildDedupeKey(payload),
    transaction_time,
    posted_time: pick(payload,['postedTime','bookingTime'], transaction_time),
    received_at,
    booking_date: `${yyyy}-${mm}-${dd}`,
    month_key: `${yyyy}-${mm}`,
    week_key: `${yyyy}-W${String(Math.ceil((((day - new Date(day.getFullYear(),0,1)) / 86400000) + new Date(day.getFullYear(),0,1).getDay()+1)/7)).padStart(2,'0')}`,
    day_key: `${yyyy}-${mm}-${dd}`,
    amount: Math.abs(amountRaw),
    currency: pick(payload,['currency'],'VND'),
    direction,
    transaction_type_final: rule?.transactionTypeFinal || (direction === 'income' ? 'income_transfer_in' : direction === 'expense' ? 'expense_other' : direction),
    ...metrics,
    counterparty: pick(payload,['counterparty','counterAccountName','accountName','senderName','receiverName'],'Unknown'),
    merchant: rule?.merchantHint || pick(payload,['merchant'],'Unknown'),
    normalized_description: rule?.merchantHint ? `${rule.merchantHint} / ${pick(payload,['description','content','transferContent'],'Giao dịch ngân hàng')}` : pick(payload,['description','content','transferContent'],'Giao dịch ngân hàng'),
    category: rule?.category || (direction === 'income' ? 'Thu nhập' : direction === 'transfer_internal' ? 'Chuyển nội bộ' : direction === 'refund' ? 'Hoàn tiền' : 'Khác'),
    subcategory: rule?.subcategory || 'Khác',
    payment_channel: 'bank_transfer',
    bank_name: pick(payload,['gateway','bankName','bank'],'Unknown'),
    account_alias: 'main_personal',
    is_internal_transfer: direction === 'transfer_internal',
    is_refund: direction === 'refund',
    is_debt_related: false,
    recurring_flag: false,
    confidence_score: rule?.confidenceBase || 0.55,
    needs_review: !(rule?.confidenceBase >= 0.7),
    anomaly_flag: Math.abs(amountRaw) >= 5000000,
    anomaly_reason: Math.abs(amountRaw) >= 5000000 ? 'large_amount' : '',
    tags: '',
    review_note: '',
    created_at: received_at,
    updated_at: received_at,
    raw_payload: payload
  };
  return tx;
}
async function postJson(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}
async function syncToAppsScript(tx) {
  if (!config.appsScript.url) return { skipped: true, reason: 'apps_script_not_configured' };
  return postJson(config.appsScript.url, {
    secret: config.appsScript.secret,
    spreadsheetId: config.sheet.spreadsheetId,
    raw: tx.raw_payload,
    normalized: tx
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return sendJson(res, 200, { ok: true, service: 'sepay-openclaw-local' });
  if (req.method !== 'POST' || req.url !== config.webhook.path) return sendJson(res, 404, { error: 'not_found' });

  let body = '';
  req.on('data', chunk => body += chunk.toString('utf8'));
  req.on('end', async () => {
    try {
      if (config.webhook.secret) {
        const incoming = req.headers['x-sepay-secret'] || req.headers['authorization'] || '';
        if (!String(incoming).includes(config.webhook.secret)) return sendJson(res, 401, { error: 'invalid_secret' });
      }
      const payload = body ? JSON.parse(body) : {};
      const tx = normalizePayload(payload);
      const state = readState();
      if (state.seenDedupeKeys.includes(tx.dedupe_key)) {
        logLine('duplicate_ignored', { dedupe_key: tx.dedupe_key, event_id: tx.event_id });
        return sendJson(res, 200, { ok: true, duplicate: true });
      }
      state.seenDedupeKeys = [...state.seenDedupeKeys.slice(-999), tx.dedupe_key];
      updateDaily(state, tx);
      writeState(state);
      fs.writeFileSync(path.join(rawDir, `${tx.event_id}.json`), JSON.stringify(payload, null, 2));
      fs.writeFileSync(path.join(normalizedDir, `${tx.event_id}.json`), JSON.stringify(tx, null, 2));
      const sheetResult = await syncToAppsScript(tx);
      const notification = buildNotification(tx, state);
      logLine('transaction_ingested', { event_id: tx.event_id, direction: tx.direction, amount: tx.amount, sheetResult });
      sendJson(res, 200, { ok: true, event_id: tx.event_id, notification, sheetResult });
    } catch (error) {
      logLine('webhook_error', { message: error.message, body });
      sendJson(res, 500, { ok: false, error: error.message });
    }
  });
});

server.listen(config.port, () => {
  logLine('server_started', { port: config.port, webhookPath: config.webhook.path });
});
