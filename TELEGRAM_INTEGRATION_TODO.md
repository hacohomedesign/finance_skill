# Telegram integration (giai đoạn 2.5)

## Mục tiêu
Gửi thông báo realtime và báo cáo định kỳ từ local workflow về chat Telegram hiện tại.

## Cách làm khuyến nghị
Vì server Node local không có quyền gọi trực tiếp công cụ chat nội bộ OpenClaw, nên nên dùng một trong 2 cách:

1. Poll file/outbox bằng session OpenClaw chính
2. Hoặc bổ sung một bridge HTTP nội bộ do OpenClaw/session khác đảm nhiệm

## Tạm thời
- Server đã sinh sẵn text thông báo trong response/log
- Scheduler đã sinh text báo cáo
- Bước tiếp theo là nối bridge gửi message vào Telegram chat hiện tại

## Nội dung cần gửi
### Realtime
- Vừa nhận/chi bao nhiêu
- Nhóm chi tiêu
- Hôm nay đã chi thực bao nhiêu

### Daily
- Thu vào
- Tiền ra
- Chi tiêu thực
- Top nhóm chi

### Weekly/Monthly
- Tổng hợp tương tự nhưng theo tuần/tháng
