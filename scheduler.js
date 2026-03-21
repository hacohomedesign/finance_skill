import fs from 'node:fs';
import path from 'node:path';
import { buildDailyReport, buildWeeklyReport, buildMonthlyReport } from './reporting.js';

const statePath = path.join(process.cwd(), 'data', 'scheduler-state.json');
if (!fs.existsSync(path.dirname(statePath))) fs.mkdirSync(path.dirname(statePath), { recursive: true });
if (!fs.existsSync(statePath)) fs.writeFileSync(statePath, JSON.stringify({ sent: {} }, null, 2));

function readState() { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
function writeState(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); }
function nowLocal() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })); }
function hhmm(d) { return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function dayKey(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function weekKey(d) { const start = new Date(d.getFullYear(),0,1); const w = Math.ceil((((d-start)/86400000)+start.getDay()+1)/7); return `${d.getFullYear()}-W${String(w).padStart(2,'0')}`; }

function run() {
  const state = readState();
  const d = nowLocal();
  const time = hhmm(d);
  const day = dayKey(d);
  const week = weekKey(d);
  const month = day.slice(0,7);
  const outputs = [];

  if (time === '21:30' && state.sent.daily !== day) {
    outputs.push({ type: 'daily', text: buildDailyReport(day) });
    state.sent.daily = day;
  }
  if (d.getDay() === 0 && time === '21:00' && state.sent.weekly !== week) {
    outputs.push({ type: 'weekly', text: buildWeeklyReport(week) });
    state.sent.weekly = week;
  }
  const tomorrow = new Date(d); tomorrow.setDate(d.getDate()+1);
  const isLastDay = tomorrow.getMonth() !== d.getMonth();
  if (isLastDay && time === '21:00' && state.sent.monthly !== month) {
    outputs.push({ type: 'monthly', text: buildMonthlyReport(month) });
    state.sent.monthly = month;
  }
  writeState(state);
  for (const out of outputs) console.log(JSON.stringify(out));
}

run();
setInterval(run, 60000);
