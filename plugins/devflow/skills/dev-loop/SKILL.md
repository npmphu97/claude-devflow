---
name: dev-loop
description: Run one code task through the team workflow (intake → classify → analyze → plan → implement → verify → self-review → land, all local) in a repo set up with devflow (.devflow.json). Use when the user asks to build a feature, fix a bug, or change behavior.
---

# dev-loop

Quy trình chuẩn cho một task. Làm tuần tự, không bỏ pha. Lý do từng pha: `docs/AGENT_WORKFLOW.md`.
Repo chưa có `.devflow.json` → đề xuất chạy `/devflow:init` trước.

## 0. Intake
- Đọc yêu cầu. Thiếu acceptance criteria, phạm vi (module, màn hình, vai trò) hoặc không rõ có đụng
  dữ liệu cũ không → hỏi lại người dùng, dừng tại đây.
- Viết lại acceptance criteria dạng "Khi … thì …".
- Đổi quy tắc nghiệp vụ hoặc bug logic: lập **bảng ví dụ đầu vào → đầu ra** (mẫu trong CLAUDE.md).
  Không tự bịa kết quả mong đợi; dòng chưa được xác nhận ghi `chưa xác nhận` và hỏi người dùng.
- Nhánh đã có ghi chú handoff (hook SessionStart in ra) → `/devflow:handoff resume` trước.

## 0.5. Phân loại: OpenSpec hay làm thẳng
Repo có `openspec/` → áp tiêu chí "OpenSpec: khi nào dùng" trong `CLAUDE.md`, nói kết quả + lý do trong 1 dòng.
- **Lớn → OpenSpec:** `/opsx:explore` nếu cần làm rõ (hoặc subagent `devflow:ba`), rồi
  `/opsx:propose <tên-change>`. Artifact chính là plan của pha 2 — dừng chờ người duyệt. Sau khi
  duyệt: `/opsx:apply`, vẫn giữ pha 4–6. Sau khi land vào `dev`: `/opsx:archive`.
- **Nhỏ → làm thẳng:** tiếp pha 1, plan ngắn gọn trong chat.
- **Vùng xám:** hỏi người dùng, kèm đề xuất.
Repo không có `openspec/` → mọi task làm thẳng; task lớn thì plan ở pha 2 chi tiết hơn.

## 1. Analyze
- Giao subagent Explore tìm: module / file / component liên quan, test đang có, nơi khác dùng chung
  logic sẽ sửa. Giữ context chính cho việc code.

## 2. Plan (người phải duyệt)
Task OpenSpec: `design.md` + `tasks.md` phải trả lời đủ các câu dưới. Task nhỏ: trình plan trong chat:
0. Giả định đang dùng; yêu cầu có nhiều cách hiểu thì liệt kê và hỏi.
1. Các bước và file sẽ sửa, mỗi bước kèm cách kiểm (`bước → kiểm bằng gì`).
2. Schema / dữ liệu lưu trữ: có đổi gì mà công cụ migration của dự án không tự làm? Cần script / data-tool?
3. Transaction / đồng thời: chỗ nào ghi dữ liệu, chỗ nào cần cô lập lỗi.
4. Dữ liệu cũ: cần chuyển đổi / dọn không (dry-run, idempotent, người xác nhận).
5. Ma trận test đề xuất (tiêu chí / dòng ví dụ → tầng → tên test). Hỏi người dùng giữ, cắt, hay bỏ;
   ghi quyết định vào plan.
6. Rollback nếu release lỗi.
Bỏ câu không áp dụng cho dự án (ví dụ dự án không có DB). Chờ người dùng duyệt plan rồi mới code.

Plan dài hoặc task OpenSpec: sau khi duyệt, đề xuất mở **session mới** để implement (context sạch,
chỉ mang theo plan / artifact đã duyệt).

## 3. Implement
- Mỗi task một **worktree riêng**: `npm run task -- feat/<scope>-<mô-tả>` (hoặc `fix/...`, tạo từ
  `dev`), rồi `EnterWorktree(path=...)` theo đường dẫn script in ra. Session đã ở sẵn trong một worktree
  của task thì dùng nó. Chi tiết: skill `devflow:ship`.
- Người dùng đồng ý có test: viết test trước từ bảng ví dụ / ca tái hiện bug (phải đỏ trước khi sửa).
- Commit nhỏ, Conventional Commits, scope = module.
- Nhánh > ~400 dòng (không tính test / generated) → đề xuất tách.

## 4. Verify
Chạy và đọc kết quả thật, không đoán:
- Trong lúc sửa: chỉ test liên quan (lệnh trong CLAUDE.md).
- Khi xong: `npm run check` — đúng gate của land (commitlint, hard-rules, lint / build / test theo vùng
  file trong `.devflow.json`), chạy cả trên thay đổi chưa commit. `hard-rules` in ERROR (chặn) và WARN
  (mở dòng đó, sửa nếu đúng là vi phạm).
- Test không nằm trong gate (integration cần DB, E2E...) mà thay đổi chạm tới → chạy tay theo CLAUDE.md.

**Circuit breaker:** sửa cùng một lỗi 2 lần mà vẫn đỏ → dừng, quay lại pha 2, báo người dùng root
cause đã biết và chưa biết. Không skip test, không nuốt exception.

## 5. Self-review (người viết ≠ người kiểm)
- Giao subagent **`devflow:verifier`** kiểm diff so với plan (dán plan đã duyệt vào prompt) hoặc
  `openspec/changes/<name>/`. FAIL → sửa, chạy lại pha 4, gọi lại verifier.
- `/code-review high`; `/security-review` nếu đụng auth, phân quyền, endpoint mới, upload, xử lý dữ liệu thật.
- Chỉ sửa finding ảnh hưởng đúng / sai hoặc yêu cầu; finding kiểu "nên thêm cho chắc" thì bỏ qua.

## 6. Commit và land (local, không PR; nhánh task không push)
- Commit bằng `npm run ship` (skill `devflow:ship`). Quyết định còn giá trị ghi vào body commit.
- Xoá file handoff của nhánh trong một commit trước khi land.
- Chỉ `npm run land` khi người dùng yêu cầu; gate đỏ → skill `devflow:steward`.
- `npm run promote` chỉ khi người dùng yêu cầu riêng.

Dừng giữa chừng (hết phiên, chờ người dùng, context sắp đầy) → `/devflow:handoff` trước khi dừng.

## 7. Báo cáo
Thay cho mô tả PR, gửi trong chat: đã làm gì; **bằng chứng kiểm thử** (lệnh + dòng kết quả thật,
kết luận verifier); "Thay đổi DB" nếu có; rủi ro còn lại; việc người cần làm (đọc
`git diff dev...<nhánh>`, bảo land, chạy migration production, UAT).
Task lộ ra bài học mới → đề xuất thêm vào "Bài học đã rút ra" của `CLAUDE.md`.
