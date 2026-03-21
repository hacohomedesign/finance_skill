function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents || '{}');
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('APP_SECRET') || '';
    if (expectedSecret && data.secret !== expectedSecret) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'invalid_secret' })).setMimeType(ContentService.MimeType.JSON);
    }

    const spreadsheetId = data.spreadsheetId;
    const ss = SpreadsheetApp.openById(spreadsheetId);
    ensureSheets(ss);

    appendRaw(ss.getSheetByName('transactions_raw'), data.raw || {});
    appendNormalized(ss.getSheetByName('transactions_normalized'), data.normalized || {});
    updateDailySummary(ss.getSheetByName('daily_summary'), data.normalized || {});

    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) })).setMimeType(ContentService.MimeType.JSON);
  }
}

function ensureSheets(ss) {
  const headers = {
    transactions_raw: ['event_id','source','source_event_id','dedupe_key','received_at','bank_name','account_number_masked','account_name','transaction_time','posted_time','amount','currency','raw_direction','raw_description','reference_code','balance_after','payload_json','ingest_status'],
    transactions_normalized: ['event_id','source_event_id','dedupe_key','transaction_time','posted_time','received_at','booking_date','month_key','week_key','day_key','amount','currency','direction','transaction_type_final','gross_outflow','net_effect','effective_spending','counterparty','merchant','normalized_description','category','subcategory','payment_channel','bank_name','account_alias','is_internal_transfer','is_refund','is_debt_related','recurring_flag','confidence_score','needs_review','anomaly_flag','anomaly_reason','tags','review_note','created_at','updated_at'],
    daily_summary: ['date','total_income','total_expense_gross','total_internal_transfer','total_refund','effective_spending','net_cashflow','top_categories_json','top_transactions_json','anomaly_count','updated_at'],
    weekly_summary: ['week_key','from_date','to_date','total_income','total_expense_gross','effective_spending','net_cashflow','top_categories_json','largest_transactions_json','anomaly_count','generated_at'],
    monthly_summary: ['month_key','total_income','total_expense_gross','effective_spending','net_cashflow','fixed_cost_estimate','variable_cost_estimate','top_categories_json','top_merchants_json','top_transactions_json','anomaly_count','report_markdown','generated_at'],
    classification_rules: ['priority','active','match_type','keyword_or_pattern','direction_hint','category','subcategory','transaction_type_final','merchant_hint','counterparty_hint','is_internal_transfer','is_debt_related','confidence_base','notes'],
    review_queue: ['event_id','transaction_time','amount','raw_description','proposed_direction','proposed_category','proposed_subcategory','confidence_score','reason','status','human_correction','updated_at'],
    accounts_registry: ['account_alias','bank_name','account_masked','owner_type','account_role','include_in_spending','active','notes'],
    classification_feedback: ['event_id','old_direction','new_direction','old_category','new_category','old_subcategory','new_subcategory','old_transaction_type_final','new_transaction_type_final','reason','created_at']
  };

  Object.keys(headers).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(headers[name]);
  });
}

function appendRawBatch(sheet, items) {
  const rows = items.map(raw => [
    raw.id || raw.transaction_id || raw.transactionId || '',
    'sepay',
    raw.id || raw.transaction_id || raw.transactionId || '',
    '',
    new Date().toISOString(),
    raw.gateway || raw.bankName || raw.bank || raw.bank_brand_name || '',
    raw.accountNumber || raw.account_number || '',
    raw.accountName || '',
    raw.transactionDate || raw.transaction_time || raw.created_at || raw.transaction_date || '',
    raw.postedTime || raw.bookingTime || '',
    raw.amount || raw.transferAmount || raw.money || raw.amount_in || raw.amount_out || '',
    raw.currency || 'VND',
    raw.type || raw.transactionType || raw.transferType || '',
    raw.description || raw.content || raw.transferContent || raw.transaction_content || '',
    raw.reference || raw.refNo || raw.reference_number || '',
    raw.balance || raw.balanceAfter || raw.accumulated || '',
    JSON.stringify(raw),
    'ingested'
  ]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function appendNormalizedBatch(sheet, items) {
  const rows = items.map(tx => [
    tx.event_id, tx.source_event_id, tx.dedupe_key, tx.transaction_time, tx.posted_time, tx.received_at,
    tx.booking_date, tx.month_key, tx.week_key, tx.day_key, tx.amount, tx.currency, tx.direction,
    tx.transaction_type_final, tx.gross_outflow, tx.net_effect, tx.effective_spending, tx.counterparty,
    tx.merchant, tx.normalized_description, tx.category, tx.subcategory, tx.payment_channel,
    tx.bank_name, tx.account_alias, tx.is_internal_transfer, tx.is_refund, tx.is_debt_related,
    tx.recurring_flag, tx.confidence_score, tx.needs_review, tx.anomaly_flag, tx.anomaly_reason,
    tx.tags, tx.review_note, tx.created_at, tx.updated_at
  ]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function updateDailySummary(sheet, tx) {
  const values = sheet.getDataRange().getValues();
  const header = values[0] || [];
  const dateCol = header.indexOf('date');
  const targetDate = tx.day_key;
  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if (values[i][dateCol] === targetDate) { rowIndex = i + 1; break; }
  }
  if (rowIndex === -1) {
    sheet.appendRow([targetDate, 0, 0, 0, 0, 0, 0, '[]', '[]', 0, new Date().toISOString()]);
    rowIndex = sheet.getLastRow();
  }
  const row = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = Object.fromEntries(header.map((h, i) => [h, i]));

  if (tx.direction === 'income') row[map.total_income] += Number(tx.net_effect || 0);
  if (tx.direction === 'expense') row[map.total_expense_gross] += Number(tx.gross_outflow || 0);
  if (tx.direction === 'transfer_internal') row[map.total_internal_transfer] += Number(tx.gross_outflow || 0);
  if (tx.direction === 'refund') row[map.total_refund] += Number(tx.net_effect || 0);
  row[map.effective_spending] += Number(tx.effective_spending || 0);
  row[map.net_cashflow] = Number(row[map.total_income] || 0) - Number(row[map.total_expense_gross] || 0) + Number(row[map.total_refund] || 0);
  if (tx.anomaly_flag) row[map.anomaly_count] += 1;
  row[map.updated_at] = new Date().toISOString();
  sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
}
