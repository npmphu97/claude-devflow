<!-- devflow:start — section do plugin devflow sinh; sửa các ô <...> cho đúng dự án -->
## Quy trình làm việc (devflow)

Quy trình đầy đủ: `docs/AGENT_WORKFLOW.md`. Cấu hình máy: `.devflow.json`.
**Repo chạy local:** không PR, không CI; remote chỉ là bản sao lưu của nhánh tích hợp (`dev`), nhánh
release (`main`) và tag, do script tự push. Luồng: nhánh `feat/` `fix/` ... (không push) → fast-forward
vào `dev` (`npm run land`, có gate) → fast-forward `dev` vào `main` + tag `vX.Y.Z` (`npm run promote`).
- Fix nhỏ (≤ ~3 file, không đổi quy tắc / schema) làm thẳng trên checkout `dev` bằng `/devflow:hot-fix-dev`.
- Mỗi task code dùng skill `/devflow:dev-loop`; mỗi task một worktree (`npm run task -- <nhánh>`, rồi
  `EnterWorktree(path=...)`); mọi bước git qua skill `devflow:ship` (`npm run ship|check|land|promote|sync|backup|untask`).
- Phiên cloud (container tạm, nhánh `ccr-*`): kết thúc bằng `npm run cloud-push` thay vì `git push` (chỉ backup,
  không land). Trên máy: `git fetch <remote> ccr-xxx` → `npm run task` (từ `ccr-xxx`) → `npm run land`.
- Việc máy làm được thì dùng script: `npm run check` (gate của land, không merge), `npm run hard-rules`
  (dò luật cứng trên diff), `npm run retro` (số liệu retro), `npm run handoff` (khung ghi chú),
  `npm run queue -- ready` (task làm được ngay, không còn blocker), `npm run status` (worktree nào đang
  có người làm, cách `dev` bao xa).
- **1 task = 1 nhánh = 1 lần land**; trong nhánh commit nhỏ theo bước của plan. Queue
  (`.claude/task-queue.md` ở main checkout, không commit) dùng chung cho mọi worktree.
- Trước khi land gọi subagent `devflow:verifier` (người viết ≠ người kiểm) và gửi bằng chứng thật cho người dùng.
  Miễn khi mọi file đổi nằm trong `.claude/`, `docs/` hoặc là file `.md` (chỉ cần `npm run check` xanh).
- Hook của plugin chặn cứng: skip test, `git push` gõ tay, `gh pr|release|run`, dời / merge /
  `reset --hard` lên `dev`/`main` bằng tay, SQL phá dữ liệu từ shell.
- Task nhiều phiên: `/devflow:handoff` lưu / đọc ghi chú resume trên nhánh.
- `npm run doctor`: kiểm tra repo đã sẵn sàng cho vòng devflow chưa (nhánh, tooling của gate,
  hook commit-msg có executable không...). `npm run devflow-test`: tự test các script của plugin.

## Lệnh build / test

<Lệnh compile, test liên quan, toàn bộ unit test, integration test (cần gì: DB, docker...), build, lint.
Ghi baseline: số test, số đỏ, ngày. Khi verify, không được làm tăng số test đỏ.>

## Chạy app / smoke (verify-app)

<Cách agent tự kiểm chứng tính năng chạy thật, không chỉ test: lệnh khởi động app local, tài khoản / seed
dữ liệu, URL hoặc lệnh gọi thử, cách dừng. Ví dụ: `npm run dev` → mở http://localhost:3000/login, đăng nhập
`demo@local` / seed bằng `npm run seed`. Xoá mục này nếu dự án không có app chạy được.>

## OpenSpec: khi nào dùng

<Xoá mục này nếu dự án không dùng OpenSpec.> OpenSpec (`/opsx:propose` → `/opsx:apply` → `/opsx:archive`)
dành cho thay đổi cần thống nhất yêu cầu trước khi code. Agent **tự phân loại** mọi task, nói kết quả + lý do trong 1 dòng.
`/opsx:apply` (sau khi duyệt artifact) và `/opsx:archive` (sau khi land) **bắt buộc chạy ở phiên mới**: context
của phiên propose thường đã vài trăm nghìn token, mỗi lượt gọi đọc lại toàn bộ. Agent dừng, nhắc người dùng
mở phiên mới và đưa câu lệnh cần gõ.

**DÙNG OpenSpec** khi có ÍT NHẤT MỘT điều sau:
1. Tính năng / màn hình / nhóm endpoint / module mới.
2. Đổi quy tắc nghiệp vụ người dùng thấy được (<ví dụ của dự án: cách tính tiền, lịch, điều kiện hợp lệ>).
3. Đổi phân quyền, xác thực, hoặc dữ liệu nhạy cảm.
4. Đổi schema ngoài việc thêm cột nullable / bảng mới, hoặc cần chuyển đổi / dọn dữ liệu đang có.
5. Đụng ≥ 2 module, hoặc backend + frontend với API contract mới / đổi.
6. Ước lượng > 1 ngày công hoặc > ~8 file.
7. Yêu cầu còn mơ hồ, có nhiều cách hiểu.
8. Hành vi mới mâu thuẫn với một spec đang có trong `openspec/specs/`.

**KHÔNG dùng OpenSpec** (làm thẳng theo `/devflow:dev-loop`): `fix` đưa hành vi về đúng như đã định,
khu trú ≤ ~3 file, không đổi schema; chỉnh UI nhỏ; `refactor` không đổi hành vi; `test`, `docs`,
`chore`, `style`, nâng version thư viện; thêm một field hiển thị / một bộ lọc đơn giản.

Vùng xám → đề xuất kèm lý do và hỏi người dùng một câu. Người dùng nói "dùng openspec" / "không cần
openspec" thì làm theo. Đang làm task nhỏ mà chạm tiêu chí DÙNG → dừng, báo, chuyển sang OpenSpec.

## Bảng ví dụ đầu vào → đầu ra

**Bắt buộc** khi đổi quy tắc nghiệp vụ hoặc sửa bug logic; không cần với chỉnh UI, refactor, docs.

| # | Dữ liệu có sẵn | Đầu vào / thao tác | Kết quả mong đợi | Nguồn |
|---|---|---|---|---|
| 1 | <trạng thái trước> | <thao tác> | <kết quả> | người dùng |

- Gồm ca thường, ca biên và ca **không được phép**; bug thì kèm bản ghi thật đã ẩn danh.
- Agent được nháp dòng ví dụ nhưng **không tự bịa kết quả mong đợi**: dòng chưa được người dùng xác
  nhận ghi Nguồn = `chưa xác nhận`. Dòng chạm tiền / dữ liệu quan trọng phải được xác nhận trước khi code.
- Nếu có test: mỗi dòng thành một ca test tham số hoá (hoặc một test riêng).

## Thiết kế test (đề xuất mặc định, người dùng quyết)

Trong plan (task nhỏ) hoặc `design.md` (OpenSpec), agent đề xuất **ma trận test**: mỗi acceptance
criterion / dòng ví dụ → tầng test → tên test. Người dùng giữ, cắt bớt, hoặc bỏ hẳn; nếu bỏ, ghi rõ
"Không thêm test mới theo quyết định người dùng" trong plan và báo cáo cuối task.

| Loại lỗi cần bắt | Tầng |
|---|---|
| Quy tắc tính toán, điều kiện hợp lệ | Unit |
| Transaction, constraint, query, độ dài cột | Integration (DB thật) |
| Luồng nhiều màn hình, phân quyền trên UI | Automation (E2E) |

Mặc định: `fix` → test tái hiện ở đúng tầng lỗi xảy ra, viết trước khi sửa.

## Cách viết thay đổi

- **Nói rõ giả định trước khi code.** Yêu cầu có nhiều cách hiểu thì liệt kê, không tự chọn âm thầm.
- **Ít code nhất đủ giải quyết.** Không thêm tính năng, abstraction, cấu hình hay xử lý lỗi ngoài yêu cầu.
- **Chỉ sửa chỗ cần sửa.** Không tiện tay sửa code / comment / format kế bên; thấy code chết không
  liên quan thì báo, không xoá. Mỗi dòng thay đổi phải truy ngược được về yêu cầu.

## Luật cứng (không được vi phạm)

Luật nào máy kiểm được thì thêm vào `rules` của `.devflow.json` (chạy trong gate của `land`).
1. **Test:** không skip/disable/xoá test đang có, không cờ bỏ qua test để qua gate, không xoá assertion.
2. **Version:** không sửa tay version trong file build; phiên bản thật là tag do `npm run promote` tạo.
3. **Secrets:** không commit mật khẩu / khoá thật.
4. **Lịch sử:** `dev`/`main` chỉ đi tới bằng fast-forward qua script; không force-push, không sửa lịch sử đã land.
5. <Luật riêng của dự án: schema / migration, transaction, kiến trúc layer, bảo mật, tiền tệ...>

## Quy ước

- Commit: Conventional Commits, scope = <tên module / package>. commitlint chặn commit sai định dạng.
- Nhánh: `feat/<scope>-<mô-tả>`, `fix/<scope>-<mô-tả>` (hoặc `chore/`, `docs/`, ...) tách từ `dev`.

## Ghi chú giữa các session

- Resume task nhiều phiên: `/devflow:handoff` (tối đa ~30 dòng, commit trên nhánh). Xoá ghi chú trước
  khi land; quyết định còn giá trị chuyển vào body commit (hoặc `design.md` với OpenSpec).
- Plan (plan mode, phân tích / đề xuất trước khi code) lưu ở `.claude/plans/` của repo (`plansDirectory` trong
  `.claude/settings.json`), không ở `~/.claude/plans/`. Tên file kebab-case mô tả nội dung. Task nhỏ: sau
  khi duyệt, chép đúng bản đã duyệt vào `.claude/plans/<nhánh>.md` trong worktree (commit trên nhánh,
  verifier đọc file này, xoá trước khi land như handoff).
- Không viết changelog riêng: `npm run promote` sinh release notes từ commit vào annotated tag.

## Bài học đã rút ra

Cập nhật sau mỗi sự cố (`/devflow:retro`). Mỗi bài học 1–2 dòng, kèm tháng.
<!-- devflow:end -->
