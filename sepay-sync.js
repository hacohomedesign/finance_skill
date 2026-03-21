import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.join(root, '.env'));
const apiConfig = JSON.parse(fs.readFileSync(path.join(root, 'sepay-api-config.json'), 'utf8'));
const dataDir = path.join(root, 'data');
const rawDir = path.join(dataDir, 'raw');
const normalizedDir = path.join(dataDir, 'normalized');
const statePath = path.join(dataDir, 'sepay-sync-state.json');
const rules = JSON.parse(fs.readFileSync(path.join(root, 'classification-rules.json'), 'utf8')).filter(r => r.active);
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

for (const dir of [dataDir, rawDir, normalizedDir]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(statePath)) fs.writeFileSync(statePath, JSON.stringify({ seenIds: [] }, null, 2));

function readState() { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
function writeState(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); }
function normalizeText(value = '') { return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function matchRule(text) {
  for (const r of rules.sort((a,b)=>a.priority-b.priority)) {
    if (r.matchType === 'contains' && text.includes(normalizeText(r.pattern))) return r;
    if (r.matchType === 'containsAny' && Array.isArray(r.pattern) && r.pattern.some(p => text.includes(normalizeText(p)))) return r;
  }
  return null;
}
function deriveDirection(tx) {
  const out = Number(tx.amount_out || 0);
  const incoming = Number(tx.amount_in || 0);
  if (incoming > 0 && out <= 0) return 'income';
  if (out > 0 && incoming <= 0) return 'expense';
  return 'unknown';
}
function deriveMetrics(direction, amount) {
  const abs = Math.abs(Number(amount || 0));
  if (direction === 'income') return { gross_outflow: 0, net_effect: abs, effective_spending: 0 };
  if (direction === 'expense') return { gross_outflow: abs, net_effect: -abs, effective_spending: abs };
  return { gross_outflow: 0, net_effect: 0, effective_spending: 0 };
}
function getWeekKey(dateString) {
  const d = new Date(dateString.replace(' ', 'T'));
  const start = new Date(d.getFullYear(),0,1);
  const week = Math.ceil((((d-start)/86400000)+start.getDay()+1)/7);
  return `${d.getFullYear()}-W${String(week).padStart(2,'0')}`;
}
function normalizeTransaction(tx) {
  const direction = deriveDirection(tx);
  const amount = direction === 'income' ? Number(tx.amount_in || 0) : Number(tx.amount_out || 0);
  const text = normalizeText(tx.transaction_content || '');
  const rule = matchRule(text);
  const date = String(tx.transaction_date || '');
  const dayKey = date.slice(0,10);
  const metrics = deriveMetrics(direction, amount);
  return {
    event_id: String(tx.id),
    source_event_id: String(tx.id),
    dedupe_key: `sepay_api_${tx.id}`,
    transaction_time: date,
    posted_time: date,
    received_at: new Date().toISOString(),
    booking_date: dayKey,
    month_key: dayKey.slice(0,7),
    week_key: getWeekKey(date),
    day_key: dayKey,
    amount,
    currency: 'VND',
    direction,
    transaction_type_final: rule?.transactionTypeFinal || (direction === 'income' ? 'income_transfer_in' : 'expense_other'),
    ...metrics,
    counterparty: 'Unknown',
    merchant: rule?.merchantHint || 'Unknown',
    normalized_description: tx.transaction_content || '',
    category: rule?.category || (direction === 'income' ? 'Thu nhập' : 'Khác'),
    subcategory: rule?.subcategory || 'Khác',
    payment_channel: 'bank_transfer',
    bank_name: tx.bank_brand_name || 'Unknown',
    account_alias: 'main_personal',
    is_internal_transfer: false,
    is_refund: false,
    is_debt_related: false,
    recurring_flag: false,
    confidence_score: rule?.confidenceBase || 0.6,
    needs_review: !(rule?.confidenceBase >= 0.7),
    anomaly_flag: Number(amount) >= 5000000,
    anomaly_reason: Number(amount) >= 5000000 ? 'large_amount' : '',
    tags: '',
    review_note: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    raw_payload: tx
  };
}
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, text: await res.text() };
}
async function syncBatchToSheet(rawItems, normalizedItems) {
  if (!config.appsScript.url) return { skipped: true };
  return postJson(config.appsScript.url, {
    secret: config.appsScript.secret,
    spreadsheetId: config.sheet.spreadsheetId,
    rawItems,
    normalizedItems
  });
}
async function main() {
  const token = process.env[apiConfig.tokenEnvVar || 'SEPAY_API_TOKEN'];
  if (!token) throw new Error(`Missing API token in env var ${apiConfig.tokenEnvVar || 'SEPAY_API_TOKEN'}`);
  const res = await fetch(`${apiConfig.baseUrl}${apiConfig.listEndpoint}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  const txs = json.transactions || [];
  const state = readState();
  const fresh = txs.filter(tx => !state.seenIds.includes(String(tx.id)));
  const normalizedItems = [];
  for (const tx of fresh) {
    const normalized = normalizeTransaction(tx);
    fs.writeFileSync(path.join(rawDir, `${tx.id}.api.json`), JSON.stringify(tx, null, 2));
    fs.writeFileSync(path.join(normalizedDir, `${tx.id}.json`), JSON.stringify(normalized, null, 2));
    normalizedItems.push(normalized);
    state.seenIds.push(String(tx.id));
  }
  const sheet = fresh.length ? await syncBatchToSheet(fresh, normalizedItems) : { skipped: true, reason: 'no_fresh_transactions' };
  state.seenIds = state.seenIds.slice(-5000);
  writeState(state);
  console.log(JSON.stringify({ ok: true, fetched: txs.length, fresh: fresh.length, sheet }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
