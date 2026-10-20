---
name: opsx-run
description: Run a whole OpenSpec change whose artifacts are already approved — worktree, apply (subagent), check, verifier, review, commit, land per the chosen land mode, untask + archive (script), final report — in a repo set up with devflow and openspec. Use when the user types "/devflow:opsx-run <name>" or says to continue change <name> after approving proposal/specs/design/tasks.
---

# opsx-run

Điều phối pha 3–7 của `devflow:dev-loop` cho một change OpenSpec **đã duyệt artifact**, để người dùng chỉ
duyệt artifact rồi nhận một báo cáo cuối. Chạy ở **phiên chính** (subagent không gọi lồng được subagent).
Lý do dùng subagent cho apply: xem mục OpenSpec trong `CLAUDE.md`.

**Phiên chính ở lại repo chính suốt chuỗi, không `EnterWorktree`.** Lệnh chạy trong worktree `<wt>` bằng
`npm --prefix "<wt>" run <script>` hoặc `git -C "<wt>"`; nhờ vậy sau land, `untask` và archive chạy thẳng từ
repo chính, không có bước "thoát worktree" để quên. Người dùng có thể `/clear` phiên sau khi duyệt artifact rồi
gõ `/devflow:opsx-run <name>`: mọi thứ cần thiết nằm trong `openspec/changes/<name>/` và git, không nằm trong hội thoại.

## 0. Điều kiện bắt đầu — thiếu một ý thì dừng, báo người dùng

- Có `<name>` (kebab-case); không có thì hỏi hoặc `openspec list --json`.
- `openspec status --change "<name>" --json`: mọi artifact `done`/`skipped`.
- Artifact đã được duyệt: `design.md` có mục "Chế độ land" (`auto-land` hoặc `manual`, kèm lý do), mục này
  được ghi lúc người dùng duyệt nên phiên mới sau `/clear` vẫn dùng được làm bằng chứng. Chưa có mục đó →
  hỏi người dùng duyệt và chọn chế độ (xem `dev-loop` pha 2) rồi ghi vào `design.md` trước khi làm tiếp.
- Có `openspec/changes/<name>/handoff.md` → đọc trước (`/devflow:handoff resume`).

## 1. Worktree
Propose đã chạy trong worktree riêng nên worktree của change có sẵn: tìm bằng
`git worktree list --porcelain`, lấy cái có `openspec/changes/<name>/` (đã commit trên nhánh). Dùng nó làm
`<wt>`; **không** tạo worktree mới, **không** `EnterWorktree`. Change lấy từ queue: `npm run queue -- start <id> --branch ...`.
Không có worktree nào (change cũ còn untracked ở `dev`): `npm run task -- feat/<scope>-<name>`, chép thư mục
đó vào `<wt>`, commit trên nhánh (`npm --prefix "<wt>" run ship -- ...`), và dọn bản untracked ở repo chính
sau khi land (nếu không, fast-forward `dev` sẽ đè lỗi lên file untracked trùng tên).

## 2. Apply — subagent
`Agent` (general-purpose, context sạch). Prompt chỉ gồm: đường dẫn worktree (tuyệt đối; "chỉ sửa file trong
đó, chạy lệnh bằng `cd` vào đó"), tên change, "chạy `/opsx:apply <name>` rồi `npm run check`; dừng và báo khi gặp điều kiện Pause của apply;
trả về: số task xong/tổng, kết quả `check`, câu hỏi cần người quyết". Không chép lại nội dung artifact.
- Subagent báo Pause/câu hỏi → chuyển nguyên văn cho người dùng, rồi `SendMessage` trả lời để nó làm tiếp.
- Nó lộ ra lỗi thiết kế → dừng, đề xuất `/opsx:update`, không tự đổi artifact.

## 3. Verify và review (liền mạch, phiên chính)
1. `npm --prefix "<wt>" run check`. Đỏ → sửa root cause theo `devflow:steward`; **tối đa 2 vòng** cho cùng một
   lỗi (circuit breaker của `dev-loop` pha 4), quá thì dừng và báo.
2. Test không nằm trong gate mà thay đổi chạm tới (integration cần DB, E2E...) → chạy thêm theo CLAUDE.md.
3. Subagent `devflow:verifier` kiểm diff so với `openspec/changes/<name>/` (prompt chỉ đưa đường dẫn). FAIL →
   sửa, quay lại bước 1. Được miễn khi mọi file đổi nằm trong `.claude/`, `docs/` hoặc là `.md`.
4. `/code-review high`; thêm `/security-review` nếu đụng auth / phân quyền / endpoint mới / xử lý dữ liệu thật.
   Chỉ sửa finding ảnh hưởng đúng/sai hoặc yêu cầu. Theo "Luật review" của `dev-loop` pha 5:
   tối đa 3 vòng, còn finding thì dừng và báo người dùng duyệt.

## 4. Commit
Xoá handoff của change (nếu có) và commit bằng `npm --prefix "<wt>" run ship -- ...` (skill `devflow:ship`; message
vào file, `-F`).
Artifact OpenSpec commit cùng nhánh với code.

## 5. Land — theo "Chế độ land" trong `design.md`

**`manual`:** gửi báo cáo (`dev-loop` pha 7), **dừng** chờ người dùng bảo land. Khi họ bảo:
`npm --prefix "<wt>" run land`, rồi sang bước 6. Lời bảo land này cũng bao gồm archive ở bước 6.

**`auto-land`:** chỉ land nếu **đủ cả**: `check` xanh, verifier PASS (hoặc được miễn), không còn finding
review chưa xử lý, `hard-rules` không ERROR và mọi WARN đã đọc. Rồi `npm --prefix "<wt>" run land`. Thiếu một ý, hoặc
diff thực tế chạm vùng buộc `manual` (xem `dev-loop` pha 2) dù lúc duyệt chưa tính tới → **không land**,
báo người dùng lý do, chuyển thành `manual`. Gate đỏ → `steward`, không lách.

`promote` không bao giờ nằm trong skill này.

## 6. Untask và archive — script, tự chạy ngay sau land
Từ repo chính (phiên chính vẫn đang ở đó), liền sau land, không chờ thêm lời bảo:
1. `npm run queue -- done <id>` (nếu có), rồi `npm run untask -- <nhánh>` gỡ worktree của task.
2. `npm run archive -- <name>`: worktree `chore/archive-<name>` → `openspec archive -y` → commit
   `chore(openspec): archive <name>` → `check` → `land` → `untask`. Archive land theo cùng chế độ với bước 5
   (đã được duyệt cùng plan).

Script **tự từ chối** (không đổi gì, dọn sạch worktree của nó) khi `tasks.md` chưa tick đủ hoặc CLI OpenSpec
báo lỗi (spec thiếu scenario, xung đột...). Khi đó mới dùng đường subagent: tạo worktree
`chore/archive-<name>` (`npm run task`), giao `Agent` (context sạch) chạy `/opsx:archive <name>` trong đó,
rồi `check`, `land` (docs-only, miễn verifier), `untask`. Hai chỗ cần quyết định của archive skill, mặc định
khi chạy trong skill này:
- Còn artifact/task chưa xong → **không** tự đồng ý; báo người dùng.
- Có delta spec chưa sync → chọn "Sync now"; spec bị sync-blocked → báo người dùng, không tự chọn.

Lỗi do chính spec (vd. thiếu scenario) thì sửa spec trong một commit riêng rồi chạy lại script, đừng ép archive.

## 7. Báo cáo cuối
Một báo cáo theo `dev-loop` pha 7: task xong/tổng, lệnh + dòng kết quả thật (`check`, test, verifier),
"Thay đổi DB" nếu có, SHA mới của `dev`, trạng thái backup remote, archive đã xong chưa, việc người cần
làm (UAT, `promote`, migration production, data-tool).

## Dừng và báo người dùng khi
Verifier FAIL không tự sửa được · chạm circuit breaker · rebase conflict khi land · gate đỏ không rõ
nguyên nhân · subagent hỏi câu cần người quyết · việc chạm dữ liệu production. Chạy `/devflow:handoff`
trước khi dừng nếu còn dang dở.
