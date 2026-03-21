# SePay Finance — Hướng dẫn triển khai

## Kiến trúc

```
SePay API (5 phút/lần)
    ↓
sync.js (Node.js local)
    ├── Lưu local: data/normalized/*.json
    ├── Google Sheets (qua Apps Script)
    │     ├── transactions_normalized
    │     └── monthly_summary
    └── Telegram Bot (thông báo realtime + báo cáo)
```

## Bước 1 — Cấu hình `.env`

```env
SEPAY_API_TOKEN=   # Token từ SePay dashboard
TELEGRAM_BOT_TOKEN= # Token từ @BotFather trên Telegram
TELEGRAM_CHAT_ID=  # Chat ID của bạn (dùng @userinfobot để lấy)
```

## Bước 2 — Deploy Google Apps Script

1. Vào [script.google.com](https://script.google.com) → New project
2. Copy toàn bộ nội dung `google-apps-script.gs` vào
3. Sửa `CONFIG.spreadsheetId` nếu cần (hiện đã đúng)
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy URL deployment → paste vào `config.json` → `appsScript.url`
6. Chạy `setupSheets()` từ editor để tạo headers sheet

## Bước 3 — Chạy

```bash
# Chạy 1 lần (sync ngay)
npm run sync

# Chạy liên tục (cứ 5 phút sync 1 lần + gửi báo cáo hàng ngày/tháng)
npm run watch

# Test Telegram
npm run test-telegram
```

## Cấu hình `config.json`

| Key | Mô tả |
|-----|-------|
| `sync.intervalMinutes` | Tần suất sync SePay (mặc định 5 phút) |
| `report.daily` | Giờ gửi báo cáo ngày (HH:MM) |
| `report.monthly` | Giờ gửi báo cáo tháng (ngày cuối tháng) |
| `anomaly.largeAmountThreshold` | Ngưỡng cảnh báo giao dịch lớn (mặc định 5 triệu) |

## Báo cáo Telegram

- **Realtime**: Mỗi giao dịch mới → gửi ngay
- **Hàng ngày**: 21:30 VN — tổng kết thu/chi/số dư
- **Hàng tháng**: 21:00 ngày cuối tháng — báo cáo đầy đủ

## Thêm classification rules

Sửa `classification-rules.json`:

```json
{
  "priority": 10,
  "matchType": "containsAny",
  "pattern": ["ten_merchant", "tu_khoa_khac"],
  "directionHint": "expense",
  "category": "Tên nhóm",
  "subcategory": "Chi tiết",
  "transactionTypeFinal": "expense_xxx",
  "merchantHint": "Tên hiển thị",
  "confidenceBase": 0.9,
  "active": true
}
```

`matchType` hỗ trợ: `contains` (1 pattern) hoặc `containsAny` (mảng pattern)
