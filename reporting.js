import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(process.cwd(), 'data');
const normalizedDir = path.join(dataDir, 'normalized');

function readAllNormalized() {
  if (!fs.existsSync(normalizedDir)) return [];
  return fs.readdirSync(normalizedDir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(normalizedDir, f), 'utf8')))
    .sort((a, b) => String(a.transaction_time).localeCompare(String(b.transaction_time)));
}

function sum(arr, fn) { return arr.reduce((a, x) => a + Number(fn(x) || 0), 0); }
function fmt(n) { return new Intl.NumberFormat('vi-VN').format(Number(n || 0)); }

function byDay(dayKey) {
  const rows = readAllNormalized().filter(x => x.day_key === dayKey);
  const totalIncome = sum(rows.filter(x => x.direction === 'income' || x.direction === 'refund'), x => x.net_effect);
  const totalExpenseGross = sum(rows.filter(x => x.direction === 'expense' || x.direction === 'transfer_internal'), x => x.gross_outflow);
  const effectiveSpending = sum(rows, x => x.effective_spending);
  const top = Object.entries(rows.reduce((acc, x) => {
    const key = x.category || 'Khác';
    acc[key] = (acc[key] || 0) + Number(x.effective_spending || 0);
    return acc;
  }, {})).sort((a,b) => b[1]-a[1]).slice(0,3);
  return { rows, totalIncome, totalExpenseGross, effectiveSpending, top };
}

function isoDay(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function currentWeekKey(d = new Date()) {
  const start = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - start) / 86400000) + start.getDay()+1)/7);
  return `${d.getFullYear()}-W${String(week).padStart(2,'0')}`;
}

function byWeek(weekKey = currentWeekKey()) {
  const rows = readAllNormalized().filter(x => x.week_key === weekKey);
  return {
    rows,
    totalIncome: sum(rows.filter(x => x.direction === 'income' || x.direction === 'refund'), x => x.net_effect),
    totalExpenseGross: sum(rows.filter(x => x.direction === 'expense' || x.direction === 'transfer_internal'), x => x.gross_outflow),
    effectiveSpending: sum(rows, x => x.effective_spending)
  };
}

function byMonth(monthKey) {
  const target = monthKey || isoDay().slice(0,7);
  const rows = readAllNormalized().filter(x => x.month_key === target);
  return {
    rows,
    totalIncome: sum(rows.filter(x => x.direction === 'income' || x.direction === 'refund'), x => x.net_effect),
    totalExpenseGross: sum(rows.filter(x => x.direction === 'expense' || x.direction === 'transfer_internal'), x => x.gross_outflow),
    effectiveSpending: sum(rows, x => x.effective_spending)
  };
}

export function buildDailyReport(dayKey = isoDay()) {
  const r = byDay(dayKey);
  const topText = r.top.length ? r.top.map(([k,v]) => `- ${k}: ${fmt(v)}đ`).join('\n') : '- Chưa có';
  return `Tổng kết ngày ${dayKey}\n- Thu vào: ${fmt(r.totalIncome)}đ\n- Tiền ra: ${fmt(r.totalExpenseGross)}đ\n- Chi tiêu thực: ${fmt(r.effectiveSpending)}đ\n- Số giao dịch: ${r.rows.length}\n- Top nhóm chi:\n${topText}`;
}

export function buildWeeklyReport(weekKey = currentWeekKey()) {
  const r = byWeek(weekKey);
  return `Tổng kết tuần ${weekKey}\n- Thu vào: ${fmt(r.totalIncome)}đ\n- Tiền ra: ${fmt(r.totalExpenseGross)}đ\n- Chi tiêu thực: ${fmt(r.effectiveSpending)}đ\n- Số giao dịch: ${r.rows.length}`;
}

export function buildMonthlyReport(monthKey) {
  const r = byMonth(monthKey);
  return `Báo cáo tháng ${monthKey || isoDay().slice(0,7)}\n- Thu vào: ${fmt(r.totalIncome)}đ\n- Tiền ra: ${fmt(r.totalExpenseGross)}đ\n- Chi tiêu thực: ${fmt(r.effectiveSpending)}đ\n- Số giao dịch: ${r.rows.length}`;
}

if (process.argv[2] === 'daily') console.log(buildDailyReport(process.argv[3]));
if (process.argv[2] === 'weekly') console.log(buildWeeklyReport(process.argv[3]));
if (process.argv[2] === 'monthly') console.log(buildMonthlyReport(process.argv[3]));
