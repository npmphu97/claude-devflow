---
name: opsx-run
description: Run a whole OpenSpec change whose artifacts are already approved — worktree, apply (subagent), check, verifier, review, commit, land per the chosen land mode, archive (subagent), final report — in a repo set up with devflow and openspec. Use when the user types "/devflow:opsx-run <name>" or says to continue change <name> after approving proposal/specs/design/tasks.
---

# opsx-run

Điều phối pha 3–7 của `devflow:dev-loop` cho một change OpenSpec **đã duyệt artifact**, để người dùng chỉ
duyệt artifact rồi nhận một báo cáo cuối. Chạy ở **phiên chính** (subagent không gọi lồng được subagent).
Lý do dùng subagent cho apply/archive: xem mục OpenSpec trong `CLAUDE.md`.

## 0. Điều kiện bắt đầu — thiếu một ý thì dừng, báo người dùng

- Có `<name>` (kebab-case); không có thì hỏi hoặc `openspec list --json`.
- `openspec status --change "<name>" --json`: mọi artifact `done`/`skipped`.
- Người dùng đã duyệt artifact trong phiên này, **và** `design.md` có mục "Chế độ land" (`auto-land` hoặc
  `manual`, kèm lý do). Chưa có → hỏi người dùng chọn (xem `dev-loop` pha 2) rồi ghi vào `design.md`.
- Có `openspec/changes/<name>/handoff.md` → đọc trước (`/devflow:handoff resume`).

## 1. Worktree
`npm run task -- feat/<scope>-<name>` (hoặc `chore/`...) rồi `EnterWorktree(path=...)`; change lấy từ queue thì
`npm run queue -- start <id> --branch ...`. Artifact `openspec/changes/<name>/` phải có trong worktree
(commit chúng vào nhánh nếu còn untracked ở `dev`).

## 2. Apply — subagent
`Agent` (general-purpose, context sạch). Prompt chỉ gồm: đường dẫn worktree (dùng đường dẫn tuyệt đối),
tên change, "chạy `/opsx:apply <name>` rồi `npm run check`; dừng và báo khi gặp điều kiện Pause của apply;
trả về: số task xong/tổng, kết quả `check`, câu hỏi cần người quyết". Không chép lại nội dung artifact.
- Subagent báo Pause/câu hỏi → chuyển nguyên văn cho người dùng, rồi `SendMessage` trả lời để nó làm tiếp.
- Nó lộ ra lỗi thiết kế → dừng, đề xuất `/opsx:update`, không tự đổi artifact.

## 3. Verify và review (liền mạch, phiên chính)
1. `npm run check` trong worktree. Đỏ → sửa root cause theo `devflow:steward`; **tối đa 2 vòng** cho cùng một
   lỗi (circuit breaker của `dev-loop` pha 4), quá thì dừng và báo.
2. Test không nằm trong gate mà thay đổi chạm tới (integration cần DB, E2E...) → chạy thêm theo CLAUDE.md.
3. Subagent `devflow:verifier` kiểm diff so với `openspec/changes/<name>/` (prompt chỉ đưa đường dẫn). FAIL →
   sửa, quay lại bước 1. Được miễn khi mọi file đổi nằm trong `.claude/`, `docs/` hoặc là `.md`.
4. `/code-review high`; thêm `/security-review` nếu đụng auth / phân quyền / endpoint mới / xử lý dữ liệu thật.
   Chỉ sửa finding ảnh hưởng đúng/sai hoặc yêu cầu.

## 4. Commit
Xoá handoff của change (nếu có) và commit bằng `npm run ship` (skill `devflow:ship`; message vào file, `-F`).
Artifact OpenSpec commit cùng nhánh với code.

## 5. Land — theo "Chế độ land" trong `design.md`

**`manual`:** gửi báo cáo (`dev-loop` pha 7), **dừng** chờ người dùng bảo land. Khi họ bảo: `npm run land`,
rồi sang bước 6. Lời bảo land này cũng bao gồm archive ở bước 6.

**`auto-land`:** chỉ land nếu **đủ cả**: `check` xanh, verifier PASS (hoặc được miễn), không còn finding
review chưa xử lý, `hard-rules` không ERROR và mọi WARN đã đọc. Rồi `npm run land`. Thiếu một ý, hoặc
diff thực tế chạm vùng buộc `manual` (xem `dev-loop` pha 2) dù lúc duyệt chưa tính tới → **không land**,
báo người dùng lý do, chuyển thành `manual`. Gate đỏ → `steward`, không lách.

`promote` không bao giờ nằm trong skill này.

## 6. Archive — subagent
Sau khi land vào `dev`: `npm run queue -- done <id>` (nếu có), `ExitWorktree(action="keep")`,
`npm run untask -- <nhánh>` (từ repo chính), rồi `npm run task -- chore/archive-<name>` (tạo từ `dev` đã chứa
code vừa land) và `EnterWorktree`. Giao `Agent` (context sạch) chạy
`/opsx:archive <name>` trong đó. Hai chỗ cần quyết định của archive skill, mặc định khi chạy trong skill này:
- Còn artifact/task chưa xong → **không** tự đồng ý; báo người dùng.
- Có delta spec chưa sync → chọn "Sync now"; spec bị sync-blocked → báo người dùng, không tự chọn.

Commit archive riêng (`chore(openspec): archive <name> ...`), `check`, `land` (docs-only, miễn verifier),
`untask`. Archive land theo cùng chế độ với bước 5 (đã được duyệt cùng plan).

## 7. Báo cáo cuối
Một báo cáo theo `dev-loop` pha 7: task xong/tổng, lệnh + dòng kết quả thật (`check`, test, verifier),
"Thay đổi DB" nếu có, SHA mới của `dev`, trạng thái backup remote, archive đã xong chưa, việc người cần
làm (UAT, `promote`, migration production, data-tool).

## Dừng và báo người dùng khi
Verifier FAIL không tự sửa được · chạm circuit breaker · rebase conflict khi land · gate đỏ không rõ
nguyên nhân · subagent hỏi câu cần người quyết · việc chạm dữ liệu production. Chạy `/devflow:handoff`
trước khi dừng nếu còn dang dở.
