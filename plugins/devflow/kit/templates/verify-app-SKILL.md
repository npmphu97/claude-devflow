---
name: verify-app
description: Prove that a change works in the running app of this project — start it, exercise the features the diff touches, collect evidence (responses, output, screenshots), stop it. Use after the land gate is green for any change a user can see (dev-loop phase 4), or when asked to "verify the app" / "chạy thử app".
context: fork
---

# verify-app — <tên dự án>

Sinh bởi `/devflow:verify-setup`; cập nhật bằng skill đó khi app đổi cách chạy hoặc có tính năng mới.
Chạy trong subagent: chỉ trả về kết luận + bằng chứng, không trả log dài.

## Khởi động

- Cần trước: <DB / docker / biến môi trường; lệnh tạo seed, ví dụ `npm run seed`>
- Chạy: `<lệnh khởi động>` ở nền (Bash `run_in_background`), log ra `<file log>`.
- Sẵn sàng khi: `<lệnh kiểm, ví dụ curl -sf http://localhost:3000/health>` trả 0 (thử tối đa ~60 giây).
- Tài khoản: <vai trò → đăng nhập bằng gì; không dùng tài khoản thật>
- Dừng: <lệnh dừng / kill tiến trình đã chạy>. Luôn dừng, kể cả khi kiểm thất bại.

## Bản đồ tính năng

| Tính năng | File / thư mục | Cách kiểm (lệnh hoặc thao tác) | Bằng chứng mong đợi |
|---|---|---|---|
| <đăng nhập> | <src/auth/> | <curl -X POST .../login ...> | <200 + token; sai mật khẩu → 401> |

## Quy trình

1. Lấy file đổi: `git diff --name-only <nhánh tích hợp>...HEAD` cộng thay đổi chưa commit (`git status --porcelain`).
   Ánh xạ sang các dòng của bản đồ. File không thuộc dòng nào mà người dùng thấy được → kiểm luồng gần nhất và ghi
   "chưa có trong bản đồ" vào kết luận.
2. Khởi động theo mục trên. Không khởi động được → dừng, báo lỗi thật (dòng log), kết luận `BLOCKED`.
3. Với mỗi dòng bị chạm: chạy cách kiểm, cả ca đúng và một ca sai / bị cấm nếu có. Thay đổi giao diện: chụp màn
   hình bằng Playwright / trình duyệt nếu có, so với mô tả yêu cầu.
4. Dừng app.
5. Trả về: mỗi tính năng `PASS` / `FAIL` / `BLOCKED` + bằng chứng ngắn (lệnh + dòng kết quả, đường dẫn ảnh).
   Không được kết luận PASS khi chưa thật sự chạy.
