---
name: verify-setup
description: Create or update the project's own `verify-app` skill (.claude/skills/verify-app/SKILL.md) — how to start the app, seed data and accounts, readiness check, and a feature map with a concrete smoke check per feature — and prove it by running it once. Use when the user says "verify-setup", when dev-loop finds no verify-app skill for a user-visible change, or when the app's start command or features changed.
---

# verify-setup

Cho agent một cách **tự chứng minh** thay đổi chạy được trên app thật, thay vì chỉ dựa vào gate. Kết quả là
skill riêng của dự án `.claude/skills/verify-app/SKILL.md` (commit vào repo), mà `dev-loop` pha 4 gọi.
Mẫu: `${CLAUDE_PLUGIN_ROOT}/kit/templates/verify-app-SKILL.md` (biến chưa được thay → Glob
`**/devflow/kit/templates/verify-app-SKILL.md` dưới `~/.claude/plugins/`).

## Tạo mới

1. **Tìm hiểu** (subagent Explore, giữ context chính gọn): lệnh chạy app (`package.json` scripts, `docker-compose`,
   `Makefile`, README), cổng / URL, health endpoint, seed / fixture, tài khoản demo, các route / màn hình / lệnh
   CLI chính. Nhiều app (api + web) → một mục "Khởi động" cho mỗi app trong cùng skill.
2. **Hỏi người dùng 1 lần** (AskUserQuestion) những gì không đọc được từ code: dịch vụ ngoài cần bật, tài khoản
   dùng để thử, dữ liệu nào được phép tạo / xoá. Không bao giờ dùng dữ liệu hay tài khoản production.
3. **Viết skill** từ mẫu vào `.claude/skills/verify-app/SKILL.md`. Bản đồ tính năng: mỗi dòng một tính năng người
   dùng thấy được, cách kiểm **chạy được nguyên văn** (lệnh curl / CLI, hoặc các bước Playwright), bằng chứng mong
   đợi cụ thể (mã HTTP, trường trong JSON, dòng chữ trên màn hình). Ưu tiên lệnh hơn thao tác tay. Bắt đầu với
   5–15 tính năng chính; không cần đủ.
4. **Chứng minh:** chạy thử skill vừa viết trên nhánh hiện tại (khởi động → 2–3 dòng của bản đồ → dừng). Lệnh nào
   sai thì sửa skill tới khi chạy được; không ghi lệnh chưa từng chạy thành công. Cái gì không tự động được (cần
   người bật VPN, OTP...) → ghi rõ trong skill là `BLOCKED` cần người, kèm lý do.
5. **CLAUDE.md:** mục "Kiểm app thật" trỏ tới skill (đã có sẵn nếu section devflow là bản ≥ 0.10).
6. **Commit** qua `npm run ship` (`chore(devflow): add verify-app skill`) trên nhánh / worktree của task đang làm,
   hoặc worktree `chore/verify-app` riêng; land khi người dùng bảo.

## Cập nhật

Khi app đổi cách chạy, hoặc `verify-app` báo file "chưa có trong bản đồ", hoặc bài học của `dev-loop` pha 8 trỏ
về đây: sửa đúng mục / dòng đó, chạy lại dòng đã sửa để chứng minh, commit như trên. Dòng của tính năng đã bị xoá
khỏi app → xoá khỏi bản đồ.

## Báo cáo
Đường dẫn skill, số tính năng trong bản đồ, kết quả lần chạy thử (lệnh + dòng kết quả), những gì còn `BLOCKED`
cần người.
