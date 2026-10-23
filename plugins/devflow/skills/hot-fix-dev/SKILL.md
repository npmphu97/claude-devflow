---
name: hot-fix-dev
description: Shortcut for a small fix done directly on the dev checkout of the main repo (no worktree, not the full dev-loop) — still goes through `ship --verify --land`, so the land gate runs. Use when the user says "hot-fix", "hotfix", "fix nhanh trên dev", "sửa thẳng dev" and the task meets the conditions in the skill.
---

# hot-fix-dev

Fix nhỏ, rõ nguyên nhân, làm ngay trong checkout `dev` của repo chính. `dev` **không bao giờ** bị
commit trực tiếp: `ship` ở `dev` tự tạo nhánh từ header commit, `--land` chạy gate rồi fast-forward
`dev` lên nhánh đó, quay về `dev` và xoá nhánh. Lịch sử `dev` vẫn thẳng, hook vẫn nguyên.
(`dev` ở đây là nhánh tích hợp trong `.devflow.json`.)

## Điều kiện — thiếu một ý thì KHÔNG dùng, quay về `/devflow:dev-loop`

- `fix` đưa hành vi về đúng như đã định (không đổi quy tắc nghiệp vụ), hoặc chỉnh UI nhỏ (nhãn, màu,
  căn lề, thông báo lỗi), hoặc `docs` / `chore` / `style` không đổi hành vi.
- Khu trú ≤ ~3 file, nguyên nhân đã rõ sau khi đọc code (không phải đoán).
- Là cỡ **S** của `dev-loop` (tả được diff trong một câu); không chạm tiêu chí OpenSpec (`${CLAUDE_PLUGIN_ROOT}/skills/dev-loop/reference.md`: schema, phân quyền, tiền, API contract, data-tool...).
- Không phải bug logic cần bảng ví dụ đầu vào → đầu ra. Bug logic phải có test tái hiện trước khi sửa:
  dùng `dev-loop`.

Giữa chừng phát hiện chạm điều kiện trên → dừng, báo người dùng, chuyển `dev-loop` / OpenSpec.

## Quy trình

1. **Kiểm tra chỗ đứng:** `git branch --show-current` phải là nhánh tích hợp (`dev`). File lạ trong
   working tree là **file khác** (không trùng file của fix) → vẫn dùng được, `ship` tự tách (bước 6).
   File của fix mà session khác cũng đang sửa dở → không dùng skill này, làm trong worktree
   (`npm run task`). Không thêm `--shared-ok`.
2. **Nói 1 dòng:** nguyên nhân + file sẽ sửa + vì sao đủ điều kiện hot-fix.
3. **Sửa tối thiểu** theo "Cách viết thay đổi" của `CLAUDE.md`; nếu có thể thì thêm test ở đúng tầng lỗi
   (ma trận test trong `${CLAUDE_PLUGIN_ROOT}/skills/dev-loop/reference.md`), không xoá / skip test.
4. **Verify trước khi commit:** `npm run check` (cùng gate của land). Đỏ → sửa root cause theo skill
   `devflow:steward`, không lách.
5. **Verifier:** gọi subagent `devflow:verifier` khi fix chạm >1 file hoặc logic; được bỏ (phải nói rõ
   đã bỏ) khi fix chỉ 1 file UI, hoặc mọi file đổi đều nằm trong `.claude/`, `docs/` hay là file `.md` —
   lúc đó chỉ cần `npm run check` xanh. Người viết ≠ người kiểm vẫn là mặc định.
6. **Đưa vào `dev`:** `land` chỉ chạy sau khi đã gửi bằng chứng (kết quả `check`, diff tóm tắt) và người
   dùng gật đầu, trừ khi họ đã nói "fix rồi land luôn". Message nhiều dòng ghi vào file trong scratchpad
   rồi dùng `-F`:

   ```bash
   npm run ship -- -m "fix(<scope>): <mô tả>" --verify --land <file> [file...]
   ```

   Commit kèm dòng attribution theo system-reminder của phiên.

   Nếu `dev` còn file khác chưa commit, `ship` tự tạo worktree tạm, chép đúng các file đã liệt kê vào
   đó, commit + gate + land từ đó, rồi trả các file đó về HEAD ở checkout chính và gỡ worktree. File
   khác không bị đụng. Gate đỏ → commit nằm trên nhánh/worktree tạm (checkout chính không còn các sửa
   đổi đó): sửa tiếp ở worktree theo `devflow:steward`.
7. **Báo cáo ngắn:** nguyên nhân, file đổi, kết quả `check`, SHA mới của `dev`, `dev` đã backup lên
   remote chưa (nếu `backup push failed` → báo, `npm run backup` sau). Có bài học đáng giữ → đề xuất theo
   `dev-loop` pha 8.

## Không bao giờ

- `git commit` / `git push` tay trên `dev`, `--no-verify`, cờ skip test, `--shared-ok`.
- `promote` — lên `main` chỉ khi người dùng bảo riêng (và không dùng `--promote` khi còn file lạ).
- Gộp nhiều việc không liên quan vào một hot-fix: mỗi hot-fix một commit, một mục đích.
- Land khi gate đỏ, hoặc khi `ship` báo rebase conflict (dừng, báo người dùng).

## Lỗi thường gặp

- `main checkout has other uncommitted changes`: chỉ còn gặp khi đang ở nhánh khác `dev` → chuyển sang worktree.
- `branch <tên> already exists`: header trùng nhánh cũ → `git switch` nhánh đó hoặc đổi header.
- Gate đỏ sau `ship`: commit đã nằm trên nhánh task (chưa vào `dev`); sửa, `ship` commit mới trên nhánh
  đó, rồi `npm run land`.
