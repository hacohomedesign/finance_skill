/**
 * sync.js — SePay → Local + Google Sheets + Telegram
 * Chạy: node sync.js
 * Chạy liên tục: node sync.js --watch
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Load env & config ──────────────────────────────────────────────────────
function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim();
    const val = t.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv(path.join(__dirname, '.env'));

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'classification-rules.json'), 'utf8'))
  .filter(r => r.active)
  .sort((a, b) => a.priority - b.priority);

// ─── Paths ──────────────────────────────────────────────────────────────────
const dataDir       = path.join(__dirname, 'data');
const normalizedDir = path.join(dataDir, 'normalized');
const statePath     = path.join(dataDir, 'sync-state.json');
const logPath       = path.join(dataDir, 'sync.log');

for (const d of [dataDir, normalizedDir]) fs.mkdirSync(d, { recursive: true });
if (!fs.existsSync(statePath)) fs.writeFileSync(statePath, JSON.stringify({ seenIds: [], lastSync: null }, null, 2));

// ─── Helpers ────────────────────────────────────────────────────────────────
function log(msg, obj) {
  const line = `[${new Date().toISOString()}] ${msg}${obj ? ' ' + JSON.stringify(obj) : ''}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
}
function readState() { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
function writeState(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); }
function fmt(n) { return new Intl.NumberFormat('vi-VN').format(Math.abs(Number(n || 0))); }

function normalizeText(v = '') {
  return String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function matchRule(text) {
  for (const r of rules) {
    if (r.matchType === 'contains' && text.includes(normalizeText(r.pattern))) return r;
    if (r.matchType === 'containsAny' && Array.isArray(r.pattern) && r.pattern.some(p => text.includes(normalizeText(p)))) return r;
  }
  return null;
}

function getWeekKey(dateStr) {
  const d = new Date(String(dateStr).replace(' ', 'T'));
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - jan1) / 86400000) + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function dayKeyOf(dateStr) {
  return String(dateStr || '').slice(0, 10);
}

// ─── Normalize SePay transaction ────────────────────────────────────────────
function normalize(tx) {
  const amountIn  = Number(tx.amount_in  || 0);
  const amountOut = Number(tx.amount_out || 0);
  const direction = amountIn > 0 && amountOut <= 0 ? 'income'
                  : amountOut > 0 && amountIn <= 0 ? 'expense'
                  : 'unknown';
  const amount    = direction === 'income' ? amountIn : amountOut;
  const rawContent   = tx.transaction_content;
  const description  = (!rawContent || rawContent === 'null') ? '' : String(rawContent);
  const text         = normalizeText(description);
  const rule      = matchRule(text);
  const dayKey    = dayKeyOf(tx.transaction_date);

  let gross_outflow = 0, net_effect = 0, effective_spending = 0;
  if (direction === 'income')  { net_effect = amount; }
  if (direction === 'expense') { gross_outflow = amount; net_effect = -amount; effective_spending = amount; }

  return {
    event_id:              String(tx.id),
    transaction_time:      tx.transaction_date || new Date().toISOString(),
    day_key:               dayKey,
    month_key:             dayKey.slice(0, 7),
    week_key:              getWeekKey(tx.transaction_date),
    amount,
    currency:              'VND',
    direction,
    transaction_type_final: rule?.transactionTypeFinal || (direction === 'income' ? 'income_transfer_in' : 'expense_other'),
    gross_outflow,
    net_effect,
    effective_spending,
    normalized_description: description,
    category:              rule?.category || (direction === 'income' ? 'Thu nhập' : 'Khác'),
    subcategory:           rule?.subcategory || 'Khác',
    merchant:              rule?.merchantHint || '',
    bank_name:             tx.bank_brand_name || '',
    account_alias:         'main',
    balance_after:         Number(tx.accumulated || 0),
    confidence_score:      rule?.confidenceBase ?? 0.6,
    needs_review:          !(rule?.confidenceBase >= 0.7),
    anomaly_flag:          amount >= cfg.anomaly.largeAmountThreshold,
    created_at:            new Date().toISOString(),
    raw: tx
  };
}

// ─── SePay API — lấy giao dịch 1 năm gần đây ────────────────────────────────
async function fetchTransactions() {
  const token = process.env.SEPAY_API_TOKEN;
  if (!token) throw new Error('Thiếu SEPAY_API_TOKEN trong .env');

  // Tính ngày bắt đầu = hôm nay - 1 năm
  const fromDate = new Date();
  fromDate.setFullYear(fromDate.getFullYear() - 1);
  const from = fromDate.toISOString().slice(0, 10); // định dạng YYYY-MM-DD

  const limit = cfg.sepay.limitPerFetch || 500;
  const url = `${cfg.sepay.baseUrl}${cfg.sepay.listEndpoint}?limit=${limit}&transaction_date_min=${from}`;

  log('Gọi SePay API', { from, limit, url });

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`SePay API lỗi: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return Array.isArray(json.transactions) ? json.transactions : [];
}

// ─── Telegram ───────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN || cfg.telegram.botToken;
  const chatId = process.env.TELEGRAM_CHAT_ID   || cfg.telegram.chatId;
  if (!token || !chatId) { log('Telegram chưa cấu hình, bỏ qua gửi tin'); return; }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
  const json = await res.json();
  if (!json.ok) log('Telegram lỗi', json);
  return json;
}

function buildTxMessage(tx) {
  const icon = tx.direction === 'income' ? '💰' : tx.direction === 'expense' ? '💸' : '🔄';
  const label = tx.direction === 'income' ? 'Nhận tiền' : tx.direction === 'expense' ? 'Chi tiêu' : 'Giao dịch';
  const lines = [
    `${icon} <b>${label}: ${fmt(tx.amount)}đ</b>`,
    `📂 ${tx.category}${tx.subcategory !== 'Khác' ? ' › ' + tx.subcategory : ''}`,
    `📝 ${tx.normalized_description || '(không có mô tả)'}`,
    tx.balance_after ? `🏦 Số dư: ${fmt(tx.balance_after)}đ` : null,
    tx.anomaly_flag ? `⚠️ Giao dịch lớn!` : null
  ].filter(Boolean);
  return lines.join('\n');
}

// ─── Google Apps Script ─────────────────────────────────────────────────────
async function postToSheet(kind, payload) {
  if (!cfg.appsScript.url) return { skipped: true, reason: 'apps_script_not_configured' };
  const body = { kind, secret: cfg.appsScript.secret, spreadsheetId: cfg.sheet.spreadsheetId, payload };
  const res = await fetch(cfg.appsScript.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, raw: text }; }
}

async function saveToSheet(tx) {
  const sheetPayload = {
    'Mã GD': tx.event_id,
    'Thời gian': tx.transaction_time,
    'Loại': tx.direction === 'income' ? 'Thu' : tx.direction === 'expense' ? 'Chi' : 'Nội bộ',
    'Số tiền': tx.amount,
    'Chi tiêu thực': tx.effective_spending,
    'Nhóm': tx.category,
    'Chi tiết': tx.subcategory,
    'Nội dung': tx.normalized_description,
    'Số dư': tx.balance_after
  };
  return await postToSheet('append_normalized', sheetPayload);
}

async function updateMonthlySummarySheet(monthKey) {
  const rows = readAllNormalized().filter(x => x.month_key === monthKey);
  const totalIncome   = rows.filter(x => x.direction === 'income').reduce((s, x) => s + x.net_effect, 0);
  const totalExpense  = rows.filter(x => x.direction === 'expense').reduce((s, x) => s + x.gross_outflow, 0);
  const effectiveSpending = rows.reduce((s, x) => s + x.effective_spending, 0);
  const topCats = Object.entries(
    rows.reduce((acc, x) => { acc[x.category] = (acc[x.category] || 0) + x.effective_spending; return acc; }, {})
  ).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return postToSheet('upsert_monthly_summary', {
    'Tháng': monthKey,
    'Tổng thu': totalIncome,
    'Tổng chi': totalExpense,
    'Chi tiêu thực': effectiveSpending,
    'Dòng tiền': totalIncome - totalExpense,
    'Số GD': rows.length,
    'Top nhóm chi': JSON.stringify(topCats),
    'Ngày chốt': new Date().toISOString()
  });
}

// ─── Local storage helpers ────────────────────────────────────────────────────
function readAllNormalized() {
  if (!fs.existsSync(normalizedDir)) return [];
  return fs.readdirSync(normalizedDir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(normalizedDir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(a.transaction_time).localeCompare(String(b.transaction_time)));
}

// ─── Reporting ───────────────────────────────────────────────────────────────
function buildDailyReport(dayKey) {
  const rows = readAllNormalized().filter(x => x.day_key === dayKey);
  if (!rows.length) return null;
  const totalIncome  = rows.filter(x => x.direction === 'income').reduce((s, x) => s + x.net_effect, 0);
  const totalExpense = rows.filter(x => x.direction === 'expense').reduce((s, x) => s + x.gross_outflow, 0);
  const effective    = rows.reduce((s, x) => s + x.effective_spending, 0);
  const top = Object.entries(
    rows.reduce((acc, x) => { acc[x.category] = (acc[x.category] || 0) + x.effective_spending; return acc; }, {})
  ).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `  · ${k}: ${fmt(v)}đ`).join('\n');

  const lastBalance = rows[rows.length - 1]?.balance_after;
  return [
    `📊 <b>Tổng kết ngày ${dayKey}</b>`,
    `💰 Thu vào: ${fmt(totalIncome)}đ`,
    `💸 Chi ra: ${fmt(totalExpense)}đ`,
    `✅ Chi tiêu thực: ${fmt(effective)}đ`,
    `🔢 Số giao dịch: ${rows.length}`,
    lastBalance ? `🏦 Số dư cuối: ${fmt(lastBalance)}đ` : null,
    top ? `\n📂 Top nhóm chi:\n${top}` : null
  ].filter(Boolean).join('\n');
}

function buildMonthlyReport(monthKey) {
  const rows = readAllNormalized().filter(x => x.month_key === monthKey);
  if (!rows.length) return null;
  const totalIncome  = rows.filter(x => x.direction === 'income').reduce((s, x) => s + x.net_effect, 0);
  const totalExpense = rows.filter(x => x.direction === 'expense').reduce((s, x) => s + x.gross_outflow, 0);
  const effective    = rows.reduce((s, x) => s + x.effective_spending, 0);
  const top = Object.entries(
    rows.reduce((acc, x) => { acc[x.category] = (acc[x.category] || 0) + x.effective_spending; return acc; }, {})
  ).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `  · ${k}: ${fmt(v)}đ`).join('\n');
  const lastBalance = rows[rows.length - 1]?.balance_after;

  return [
    `📅 <b>Báo cáo tháng ${monthKey}</b>`,
    `💰 Tổng thu: ${fmt(totalIncome)}đ`,
    `💸 Tổng chi: ${fmt(totalExpense)}đ`,
    `✅ Chi tiêu thực: ${fmt(effective)}đ`,
    `📈 Net cashflow: ${totalIncome - totalExpense >= 0 ? '+' : ''}${fmt(totalIncome - totalExpense)}đ`,
    `🔢 Tổng giao dịch: ${rows.length}`,
    lastBalance ? `🏦 Số dư cuối: ${fmt(lastBalance)}đ` : null,
    top ? `\n📂 Chi tiết theo nhóm:\n${top}` : null
  ].filter(Boolean).join('\n');
}

// ─── Scheduler ───────────────────────────────────────────────────────────────
function nowLocal() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: cfg.timezone || 'Asia/Ho_Chi_Minh' }));
}
function hhmm(d) { return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function localDayKey(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

let schedulerState = { daily: null, monthly: null };

async function runScheduler() {
  const d     = nowLocal();
  const time  = hhmm(d);
  const today = localDayKey(d);
  const month = today.slice(0, 7);

  if (time === cfg.report.daily && schedulerState.daily !== today) {
    schedulerState.daily = today;
    log('Gửi báo cáo ngày', { day: today });
    const msg = buildDailyReport(today);
    if (msg) await sendTelegram(msg);
    await updateMonthlySummarySheet(month);
  }

  const tomorrow = new Date(d); tomorrow.setDate(d.getDate() + 1);
  const isLastDay = tomorrow.getMonth() !== d.getMonth();
  if (isLastDay && time === cfg.report.monthly && schedulerState.monthly !== month) {
    schedulerState.monthly = month;
    log('Gửi báo cáo tháng', { month });
    const msg = buildMonthlyReport(month);
    if (msg) await sendTelegram(msg);
    await updateMonthlySummarySheet(month);
  }
}

// ─── Main sync loop ───────────────────────────────────────────────────────────
async function sync() {
  log('sync_start');
  const state = readState();
  const txs   = await fetchTransactions();
  const fresh  = txs.filter(tx => !state.seenIds.includes(String(tx.id)));
  log(`Lấy ${txs.length} giao dịch, ${fresh.length} mới`);

  for (const tx of fresh) {
    const normalized = normalize(tx);
    fs.writeFileSync(path.join(normalizedDir, `${tx.id}.json`), JSON.stringify(normalized, null, 2));
    const sheetResult = await saveToSheet(normalized);
    log('saved', { id: tx.id, direction: normalized.direction, amount: normalized.amount, sheet: sheetResult?.ok });
    const msg = buildTxMessage(normalized);
    await sendTelegram(msg);
  }

  state.seenIds = [...state.seenIds, ...fresh.map(t => String(t.id))].slice(-5000);
  state.lastSync = new Date().toISOString();
  writeState(state);
  log('sync_done', { fresh: fresh.length });
}

// ─── Entry point ─────────────────────────────────────────────────────────────
const isWatch = process.argv.includes('--watch');
const intervalMs = (cfg.sync.intervalMinutes || 5) * 60_000;

async function main() {
  try {
    await sync();
    await runScheduler();
  } catch (err) {
    log('ERROR', { message: err.message });
  }
}

if (isWatch) {
  log('Chạy liên tục, interval:', { minutes: cfg.sync.intervalMinutes });
  main();
  setInterval(main, intervalMs);
} else {
  main();
}

export { buildDailyReport, buildMonthlyReport, sendTelegram, readAllNormalized };
