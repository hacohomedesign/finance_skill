/**
 * Google Apps Script — SePay Finance Bridge
 * Deploy as: Web app → Execute as Me → Anyone (hoặc Anyone with Google Account)
 *
 * Hỗ trợ các `kind`:
 *   - append_normalized     → ghi vào transactions_normalized
 *   - upsert_monthly_summary → cập nhật monthly_summary
 *   - setup_headers         → tạo tất cả sheet với header
 */

const CONFIG = {
  spreadsheetId: '12bxHwh3jZFpNY4kiKjppRiA8lAFhi0X9PoZLSvFunZQ',
  secret: ''   // Điền cùng với config.json appsScript.secret nếu muốn bảo mật
};

const HEADERS = {
  transactions_normalized: [
    'event_id','transaction_time','day_key','month_key','week_key',
    'amount','currency','direction','transaction_type_final',
    'gross_outflow','net_effect','effective_spending',
    'normalized_description','category','subcategory','merchant',
    'bank_name','account_alias','balance_after',
    'confidence_score','needs_review','anomaly_flag','created_at'
  ],
  monthly_summary: [
    'month_key','total_income','total_expense_gross','effective_spending',
    'net_cashflow','transaction_count','top_categories_json','generated_at'
  ]
};

// ─── Entry ────────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');

    if (CONFIG.secret && body.secret !== CONFIG.secret) {
      return json({ ok: false, error: 'invalid_secret' });
    }

    const ss = SpreadsheetApp.openById(body.spreadsheetId || CONFIG.spreadsheetId);

    if (body.kind === 'setup_headers') {
      Object.keys(HEADERS).forEach(name => ensureSheet(ss, name, HEADERS[name]));
      return json({ ok: true, setup: true, sheets: Object.keys(HEADERS) });
    }

    if (body.kind === 'append_normalized') {
      const sheet = ensureSheet(ss, 'transactions_normalized', HEADERS.transactions_normalized);
      // Dedupe: kiểm tra event_id đã tồn tại chưa
      const existing = getColumnValues(sheet, 'event_id');
      if (existing.includes(String(body.payload.event_id))) {
        return json({ ok: true, duplicate: true, event_id: body.payload.event_id });
      }
      appendRow(sheet, HEADERS.transactions_normalized, body.payload);
      return json({ ok: true, sheet: 'transactions_normalized', event_id: body.payload.event_id });
    }

    if (body.kind === 'upsert_monthly_summary') {
      const sheet = ensureSheet(ss, 'monthly_summary', HEADERS.monthly_summary);
      upsertRow(sheet, 'month_key', body.payload);
      return json({ ok: true, sheet: 'monthly_summary', month_key: body.payload.month_key });
    }

    return json({ ok: false, error: 'unsupported_kind: ' + body.kind });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  return json({ ok: true, service: 'sepay-finance-bridge', time: new Date().toISOString() });
}

// ─── Sheet helpers ────────────────────────────────────────────────────────────
function ensureSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

function appendRow(sheet, headers, data) {
  const row = headers.map(h => {
    const v = data[h];
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });
  sheet.appendRow(row);
}

function getColumnValues(sheet, colName) {
  if (sheet.getLastRow() <= 1) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIdx  = headers.indexOf(colName);
  if (colIdx === -1) return [];
  return sheet.getRange(2, colIdx + 1, sheet.getLastRow() - 1, 1).getValues().flat().map(String);
}

function upsertRow(sheet, keyCol, data) {
  const headers = HEADERS[sheet.getName()];
  const keyIdx  = headers.indexOf(keyCol);
  const keyVal  = String(data[keyCol]);
  const allVals = getColumnValues(sheet, keyCol);
  const rowIdx  = allVals.indexOf(keyVal);

  const row = headers.map(h => {
    const v = data[h];
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });

  if (rowIdx === -1) {
    sheet.appendRow(row);
  } else {
    sheet.getRange(rowIdx + 2, 1, 1, row.length).setValues([row]);
  }
}

function json(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Manual trigger: chạy trong Apps Script Editor để setup sheet ─────────────
function setupSheets() {
  const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  Object.keys(HEADERS).forEach(name => ensureSheet(ss, name, HEADERS[name]));
  Logger.log('Setup xong: ' + Object.keys(HEADERS).join(', '));
}
