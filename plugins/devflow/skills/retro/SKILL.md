---
name: retro
description: Weekly or post-incident retro for a devflow repo. Measures the agent loop from git history (fix-after-feat ratio, test ratio, change size, fix chains), finds repeated mistakes, and proposes CLAUDE.md lessons, hooks or land-gate rules. Use when the user says "retro", after an incident, or after 2+ fix commits on one feature.
---

# retro

1. Chọn khoảng thời gian (mặc định 7 ngày; người dùng có thể nói khác) và chạy script, **không tự đếm
   từ `git log`**:
   ```bash
   npm run retro -- 7 --ref dev     # thêm --json nếu cần số liệu thô
   ```
   Script in sẵn: commit theo type / scope; **tỉ lệ fix bám feat** (`fix(<scope>)` trong 7 ngày sau
   `feat(<scope>)` cùng scope / số `feat`, mục tiêu giảm dần); **tỉ lệ test** (dòng trong file test /
   dòng code thay đổi, mục tiêu ≥ 20 %; file test nhận theo `testPaths` của `.devflow.json`);
   5 commit lớn nhất (⚠ khi > 400 dòng); các chuỗi ≥ 2 `fix` liên tiếp cùng scope.
2. Dán bảng của script vào báo cáo. Phần của agent chỉ là diễn giải: commit lớn nào là nhập dữ liệu /
   tooling / generated (không tính là task quá to), so với lần retro trước nếu có.
3. Với mỗi chuỗi fix: đọc diff, tìm root cause chung, phân loại bài học:
   - Kiểm được bằng máy (grep, lint rule, test) → đề xuất **luật trong `rules` của `.devflow.json`**
     (regex trên dòng thêm / xoá, chạy trong gate của `land`), `rulesModule` nếu cần logic, hoặc
     hook — ưu tiên, vì luật mềm trong CLAUDE.md có thể bị bỏ qua.
   - Cần phán đoán → đề xuất **1 dòng** cho mục "Bài học đã rút ra" trong CLAUDE.md.
   - Thiếu test → đề xuất test hồi quy cụ thể.
4. Soát CLAUDE.md: dòng nào agent vẫn làm đúng khi không có nó → đề xuất xoá cho gọn.
5. Trình đề xuất cho người dùng; chỉ sửa file sau khi được duyệt. Commit `docs(claude): ...` hoặc
   `chore(devflow): ...` qua `npm run ship`.
