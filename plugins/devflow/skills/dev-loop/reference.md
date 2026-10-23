# dev-loop — tài liệu tham chiếu

Đọc mục cần thiết khi skill `dev-loop` trỏ tới; không cần đọc hết.

## Cỡ L: khi nào dùng OpenSpec

OpenSpec (`/opsx:propose` → `/opsx:apply` → `/opsx:archive`) dành cho thay đổi cần thống nhất yêu cầu trước khi
code. **Propose luôn chạy trong worktree** (`npm run task`, không `EnterWorktree`; lệnh chạy qua `cd "<wt>"`),
commit artifact trên nhánh đó; không tạo `openspec/changes/<name>/` ở checkout `dev` (thành untracked kéo dài, và
làm `land` lỗi đè file). `/opsx:apply` sau khi duyệt **bắt buộc chạy trong subagent context sạch** (công cụ
`Agent`): context của phiên propose thường đã vài trăm nghìn token, mỗi lượt gọi đọc lại toàn bộ. Archive sau land:
`npm run archive -- <name>`; script từ chối thì `/opsx:archive` cũng trong subagent. Subagent hỏi / dừng thì phiên
chính chuyển câu hỏi cho người dùng rồi `SendMessage` tiếp. Chạy trọn change đã duyệt: `/devflow:opsx-run <name>`.

**DÙNG OpenSpec** khi có ÍT NHẤT MỘT điều sau:
1. Tính năng / màn hình / nhóm endpoint / module mới.
2. Đổi quy tắc nghiệp vụ người dùng thấy được (ví dụ của dự án: mục "OpenSpec" trong `CLAUDE.md`).
3. Đổi phân quyền, xác thực, hoặc dữ liệu nhạy cảm.
4. Đổi schema ngoài việc thêm cột nullable / bảng mới, hoặc cần chuyển đổi / dọn dữ liệu đang có.
5. Đụng ≥ 2 module, hoặc backend + frontend với API contract mới / đổi.
6. Ước lượng > 1 ngày công hoặc > ~8 file.
7. Yêu cầu còn mơ hồ, có nhiều cách hiểu.
8. Hành vi mới mâu thuẫn với một spec đang có trong `openspec/specs/`.

**KHÔNG dùng** (cỡ S / M): `fix` đưa hành vi về đúng như đã định, khu trú ≤ ~3 file, không đổi schema; chỉnh UI
nhỏ; `refactor` không đổi hành vi; `test`, `docs`, `chore`, `style`, nâng version thư viện; thêm một field hiển thị /
một bộ lọc đơn giản.

Vùng xám → đề xuất kèm lý do, hỏi người dùng một câu. Người dùng nói "dùng openspec" / "không cần openspec" thì làm
theo. Đang làm cỡ S / M mà chạm tiêu chí DÙNG → dừng, báo, chuyển sang OpenSpec.

## Bảng ví dụ đầu vào → đầu ra

**Bắt buộc** khi đổi quy tắc nghiệp vụ hoặc sửa bug logic; không cần với chỉnh UI, refactor, docs.

| # | Dữ liệu có sẵn | Đầu vào / thao tác | Kết quả mong đợi | Nguồn |
|---|---|---|---|---|
| 1 | <trạng thái trước> | <thao tác> | <kết quả> | người dùng |

- Gồm ca thường, ca biên và ca **không được phép**; bug thì kèm bản ghi thật đã ẩn danh.
- Agent được nháp dòng ví dụ nhưng **không tự bịa kết quả mong đợi**: dòng chưa được người dùng xác nhận ghi
  Nguồn = `chưa xác nhận`. Dòng chạm tiền / dữ liệu quan trọng phải được xác nhận trước khi code.
- Có test: mỗi dòng thành một ca test tham số hoá (hoặc một test riêng).

## Ma trận test (đề xuất, người dùng quyết)

Trong plan (cỡ M) hoặc `design.md` (cỡ L): mỗi acceptance criterion / dòng ví dụ → tầng test → tên test. Người
dùng giữ, cắt bớt, hoặc bỏ hẳn; bỏ thì ghi "Không thêm test mới theo quyết định người dùng" trong plan và báo cáo.

| Loại lỗi cần bắt | Tầng |
|---|---|
| Quy tắc tính toán, điều kiện hợp lệ | Unit |
| Transaction, constraint, query, độ dài cột | Integration (DB thật) |
| Luồng nhiều màn hình, phân quyền trên UI | Automation (E2E) |
| Tính năng chạy thật với dữ liệu mẫu | Skill `verify-app` của dự án |

Mặc định: `fix` → test tái hiện ở đúng tầng lỗi xảy ra, viết trước khi sửa (phải đỏ trước).

## File plan và ghi chú giữa các session

- Bản nháp plan mode lưu ở `.claude/plans-draft/` của repo (`plansDirectory` trong `.claude/settings.json`,
  gitignored). `.claude/plans/<nhánh>.md` (`/` đổi thành `-`) chỉ chứa plan **đã duyệt**, commit trên nhánh,
  verifier đọc file này, xoá trước khi land.
- Task nhiều phiên: `/devflow:handoff` (≤ ~30 dòng, commit trên nhánh), xoá trước khi land; quyết định còn giá trị
  chuyển vào body commit (hoặc `design.md` với OpenSpec).
- Không viết changelog riêng: `npm run promote` sinh release notes từ commit vào annotated tag.
