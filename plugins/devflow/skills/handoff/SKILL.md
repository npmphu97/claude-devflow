---
name: handoff
description: Save or resume a short handoff note on the current task branch of a devflow repo so another session or agent can continue a multi-session task without re-reading the codebase. Use "/devflow:handoff" before stopping mid-task (end of session, waiting on the user, context nearly full) and "/devflow:handoff resume" when picking a task back up.
---

# handoff

Phần máy móc do `scripts/devflow/handoff.mjs` làm (`npm run handoff`); agent chỉ viết các ô cần phán đoán.

## Vị trí file
Script tự chọn:
- Task OpenSpec (nhánh có commit trong `openspec/changes/<name>/`): `openspec/changes/<name>/handoff.md`.
- Task nhỏ: `.claude/handoff/<nhánh>.md`, `/` của tên nhánh đổi thành `-`.

## `/devflow:handoff` (lưu)
1. `npm run handoff` (trong worktree của nhánh). Chưa có file → script tạo khung đã điền sẵn nhánh,
   ngày giờ, "Đã xong" (commit từ `dev`), "File đã đổi", "Đang ở" (tiến độ `tasks.md` với OpenSpec).
   Đã có file → script in nội dung để sửa tại chỗ.
2. Điền các ô `<...>` còn lại, **tối đa ~30 dòng**, chỉ những gì session sau không tự suy ra nhanh được:

```markdown
# Handoff: <nhánh> — <ngày giờ>
Task: <1 dòng, link issue / change>
Đang ở: <bước dev-loop hoặc task số mấy trong tasks.md>
Đã xong: <script điền sẵn>
File đã đổi: <script điền sẵn>
Tiếp theo: <1–3 việc cụ thể, việc đầu tiên làm ngay được>
Lệnh test: <lệnh đang dùng để kiểm>
Đang đỏ: <test nào, vì sao, đã thử gì>
Quyết định đã chốt: <chọn gì / bỏ gì / vì sao; ma trận test người dùng đã duyệt>
Chờ người dùng: <câu hỏi còn mở, dòng ví dụ `chưa xác nhận`>
Bẫy: <điều dễ sai trong vùng code này>
```

3. Commit riêng trên nhánh bằng lệnh script in ra (`npm run ship -- -m "chore: update handoff for <nhánh>" <file>`).
Không ghi lại nội dung đã có trong code, commit message, `tasks.md` hay CLAUDE.md.

## `/devflow:handoff resume` (đọc)
1. `npm run handoff -- resume`: in ghi chú, số commit sau lần lưu (ghi chú có thể đã cũ), thay đổi
   chưa commit. Hook SessionStart của plugin thường đã in sẵn nội dung ghi chú.
2. Chạy lại "Lệnh test" trong ghi chú.
3. Ghi chú lệch với thực tế: tin code và git, sửa lại file handoff.
4. Tiếp tục từ mục "Tiếp theo".

## Dọn
Trước khi `land` hoặc trước `/opsx:archive`: chuyển "Quyết định đã chốt" vào body commit của task
(hoặc `design.md` với OpenSpec), rồi xoá file handoff trong một commit.
