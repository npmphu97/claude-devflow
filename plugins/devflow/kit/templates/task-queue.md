# Task queue (devflow)

Mục lục chung cho mọi việc — task nhỏ, change OpenSpec lớn. File nằm ở main checkout, KHÔNG commit
(gitignore); `npm run queue` từ worktree nào cũng sửa đúng file này. Đây chỉ là INDEX, chi tiết nằm ở nơi
của nó: task nhỏ → nhánh + worktree; task lớn → `openspec/changes/<tên>/` (checklist trong
`tasks.md`); trạng thái session → handoff note (`.claude/handoff/<nhánh>.md`).

Quy ước (xem skill `devflow:queue`):
- ID `T-NNN` chỉ do `npm run queue -- add` cấp — không tự đặt tay.
- Task chỉ "ready" khi mọi ID trong `blocked by:` đã done.
- Task lớn: một dòng trỏ tới change, không copy checklist vào đây.
- Thứ tự trong Ready = thứ tự ưu tiên, do người xếp tay; agent không reorder.
- Claim = `queue start <id> --branch <type>/<scope>-<mô-tả>`: In progress + tạo nhánh/worktree.
- Agent cập nhật queue ở: intake (add), bắt đầu (start), bị chờ (block / unblock), land xong (done).

## In progress

## Ready

## Waiting

## Done
