---
name: queue
description: Shared task queue (.claude/task-queue.md) of a devflow repo — add tasks, list ready tasks (no open blockers), claim the next task, park blocked tasks, mark landed tasks done. Use when triaging new work, picking the next task to work on, or when a task gets blocked / landed.
---

# queue

`.claude/task-queue.md` là **mục lục chung** cho mọi việc (task nhỏ, change OpenSpec lớn). Nó chỉ là
index — chi tiết nằm ở nơi của nó:

| Việc | Chi tiết ở |
|---|---|
| Task nhỏ | Nhánh + worktree của nó |
| Task lớn (OpenSpec) | `openspec/changes/<tên>/` (checklist trong `tasks.md`) |
| Trạng thái session | Handoff note (`.claude/handoff/<nhánh>.md`) |

Phần máy móc do `scripts/devflow/queue.mjs` làm (`npm run queue`). ID có dạng `T-001`, **chỉ script
mới được cấp** (`queue.mjs add`) — không tự đặt tay, hai session cùng đặt sẽ trùng.

**Một file cho mọi session:** queue nằm ở **main checkout** và bị gitignore. Chạy `npm run queue` từ
worktree nào cũng đọc / ghi đúng file đó (script tự tìm main checkout, có khoá ghi), và sửa queue không
làm bẩn nhánh nào. Không commit file này; lịch sử lâu dài là `git log` + change OpenSpec đã archive.
Queue nói *làm gì*, Git (nhánh + worktree) nói *ai đang làm* — xem cả hai bằng `npm run status`.

## Lệnh

| Lệnh | Khi nào |
|---|---|
| `npm run queue` | Xem tổng quan: đang làm / ready / chờ / done |
| `npm run queue -- ready` | Task làm được ngay (mọi `blocked by` đã done), theo thứ tự ưu tiên |
| `npm run queue -- next` | Task ready ưu tiên cao nhất — "cho tôi việc tiếp theo" |
| `npm run queue -- add --title "..." [--size small\|large] [--blocked-by T-1,T-2] [--change openspec/changes/x] [--branch feat/y] [--wait "lý do"]` | Thêm task (intake). Có `--wait` → vào Waiting luôn |
| `npm run queue -- start <id> --branch feat/y` | **Claim**: In progress + tạo nhánh và worktree (`flow.mjs task`). Từ chối nếu task đã có người nhận, còn blocker, hoặc nhánh đã tồn tại (`--force` để vượt khi claim cũ đã chết). Tạo worktree lỗi → tự hoàn claim |
| `npm run queue -- block <id> --reason "..."` | Park task đang chờ (chờ người, chờ task khác, chờ bên thứ ba) |
| `npm run queue -- unblock <id>` | Hết chờ: Waiting → cuối Ready (người xếp lại ưu tiên nếu cần) |
| `npm run queue -- done <id>` | Task đã land → Done (ghi ngày) |
| `npm run queue -- prune [--days 7]` | Xoá item Done quá N ngày (git log đã lưu lịch sử) |

## Quy ước

- **Dependency:** `--blocked-by T-001,T-002` (task chỉ ready khi các ID đó đã done), `--wait` cho
  task kẹt ngay từ đầu. Dependency kỹ thuật agent tự dò từ code; dependency nghiệp vụ / ưu tiên do
  người quyết — agent đề xuất, người chốt ở pha duyệt plan.
- **Thứ tự trong Ready = thứ tự ưu tiên, do người xếp tay.** Agent không bao giờ reorder Ready.
- **Task lớn:** một dòng trỏ tới change (`--change openspec/changes/<tên>`), không copy checklist
  vào queue. Land xong → `queue.mjs done <id>` rồi `/opsx:archive`. Không archive trước khi code đã vào `dev`.
- **Không phải việc nào cũng cần queue.** Task người giao trực tiếp trong chat, làm xong trong một
  session → làm thẳng, khỏi queue. Queue dành cho: backlog chung, task nhiều session, task bị chờ.
- Queue quá ~20 item đang hoạt động thì đó là backlog cần triage, không còn là queue nữa.

## Gắn với dev-loop

- Pha 0 (Intake): yêu cầu mới → `add` vào queue (task đã có trong queue thì thôi).
- Bắt đầu implement: `next` → `start <id> --branch <type>/<scope>-<mô-tả>` (claim + worktree), rồi
  `EnterWorktree(path=...)` theo đường dẫn in ra.
- Bị chờ giữa chừng: `/devflow:handoff` (ghi chú session) + `block <id> --reason "..."`; hết chờ: `unblock <id>`.
- Land xong: `done <id>` → (`/opsx:archive`) → `untask`.
