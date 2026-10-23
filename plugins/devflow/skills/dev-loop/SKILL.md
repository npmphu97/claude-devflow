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
- Viết lại acceptance criteria dạng "Khi … thì …", mỗi tiêu chí kèm **cách chứng minh xong** (test / lệnh /
  thao tác trên app). Tiêu chí kiểm được thì agent tự lặp tới khi đạt; "làm cho chạy" thì không.
- Đổi quy tắc nghiệp vụ hoặc bug logic: lập **bảng ví dụ đầu vào → đầu ra** (mẫu trong CLAUDE.md).
  Không tự bịa kết quả mong đợi; dòng chưa được xác nhận ghi `chưa xác nhận` và hỏi người dùng.
- Nhánh đã có ghi chú handoff (hook SessionStart in ra) → `/devflow:handoff resume` trước.
- Việc mới chưa có trong queue (backlog chung, task nhiều session, task có thể bị chờ) →
  `npm run queue -- add --title "..." [--blocked-by T-..]` (skill `devflow:queue`). Task người giao trực
  tiếp, xong trong một session → khỏi queue.

## 0.5. Phân loại: OpenSpec hay làm thẳng
Repo có `openspec/` → áp tiêu chí "OpenSpec: khi nào dùng" trong `CLAUDE.md`, nói kết quả + lý do trong 1 dòng.
- **Lớn → OpenSpec:** `/opsx:explore` nếu cần làm rõ. Trước `/opsx:propose` tạo worktree:
  `npm run task -- feat/<scope>-<name>`, **không** `EnterWorktree` (như `opsx-run`): chạy `openspec` bằng
  `cd "<wt>" && openspec ...`, ghi artifact bằng đường dẫn tuyệt đối trong `<wt>`, commit bằng
  `npm --prefix "<wt>" run ship`. Artifact không bao giờ untracked ở checkout `dev`. Rồi `/opsx:propose <tên-change>`.
  Artifact chính là plan của pha 2 — dừng chờ người duyệt. Sau khi
  duyệt, agent chạy skill **`devflow:opsx-run <name>`**: worktree → `/opsx:apply` trong subagent context
  sạch (`Agent`, general-purpose) → check → verifier → review → commit → land theo "Chế độ land" →
  `npm run archive -- <name>` (script; `/opsx:archive` trong subagent khi script từ chối) → một báo cáo cuối. Người dùng không phải mở phiên mới hay nhắc từng
  bước. Subagent không hỏi được người dùng: câu hỏi của nó do phiên chính chuyển, rồi `SendMessage` để
  nó làm tiếp. Người dùng có thể `/clear` sau khi duyệt artifact rồi gõ `/devflow:opsx-run <name>`: trạng thái nằm trong
  `openspec/changes/<name>/` và git. Không có công cụ `Agent` (phiên cloud, đang là subagent) → dừng sau khi duyệt, nhắc người
  dùng mở phiên mới và gõ `/opsx:apply <name>`, rồi `/opsx:archive <name>` sau khi land. Pha 3–7 bên dưới là chi tiết của chuỗi đó (task nhỏ đi tay theo các pha này).
- **Nhỏ → làm thẳng:** tiếp pha 1, plan ngắn gọn trong chat.
- **Vùng xám:** hỏi người dùng, kèm đề xuất.
Repo không có `openspec/` → mọi task làm thẳng; task lớn thì plan ở pha 2 chi tiết hơn.

## 1. Analyze
- Giao subagent Explore tìm: module / file / component liên quan, test đang có, nơi khác dùng chung
  logic sẽ sửa. Giữ context chính cho việc code.

## 2. Plan (người phải duyệt)
Nên lập plan trong **plan mode** (chỉ đọc, chưa sửa file) và lặp với người dùng tới khi plan ổn.
Task OpenSpec: `design.md` + `tasks.md` phải trả lời đủ các câu dưới. Task nhỏ: trình plan trong chat:
0. Giả định đang dùng; yêu cầu có nhiều cách hiểu thì liệt kê và hỏi.
1. Các bước và file sẽ sửa, mỗi bước kèm cách kiểm (`bước → kiểm bằng gì`).
2. Schema / dữ liệu lưu trữ: có đổi gì mà công cụ migration của dự án không tự làm? Cần script / data-tool?
3. Transaction / đồng thời: chỗ nào ghi dữ liệu, chỗ nào cần cô lập lỗi.
4. Dữ liệu cũ: cần chuyển đổi / dọn không (dry-run, idempotent, người xác nhận).
5. Ma trận test đề xuất (tiêu chí / dòng ví dụ → tầng → tên test). Hỏi người dùng giữ, cắt, hay bỏ;
   ghi quyết định vào plan.
6. Rollback nếu release lỗi.
7. **Chế độ land** — đề xuất `auto-land` hoặc `manual` kèm lý do 1 dòng, người dùng chọn cùng lúc duyệt plan
   (OpenSpec: ghi mục "Chế độ land" vào `design.md`; task nhỏ: ghi vào `.claude/plans/<nhánh>.md`).
   - `auto-land`: sau khi `check` xanh, verifier PASS (hoặc được miễn) và không còn finding review chưa xử
     lý, agent tự `npm run land` rồi archive (nếu là OpenSpec), không chờ lời bảo.
   - `manual`: dừng sau báo cáo, chờ người dùng bảo land (lời bảo đó gồm cả archive).
   - **Buộc `manual`** (không đề xuất auto-land) khi task đụng: schema hoặc migration; phân quyền / xác
     thực / bảo mật; tiền, thanh toán, lương; công cụ sửa dữ liệu hàng loạt; hoặc cần integration test mà
     chưa chạy được. Dự án bổ sung vùng riêng trong mục "Chế độ land" của `CLAUDE.md`.
   - `promote` luôn do người dùng yêu cầu riêng, bất kể chế độ.

Bỏ câu không áp dụng cho dự án (ví dụ dự án không có DB). Chờ người dùng duyệt plan rồi mới code.

Task OpenSpec: sau khi duyệt, **bắt buộc** implement trong subagent context sạch (xem pha 0.5). Plan dài
của task nhỏ: cũng giao cho subagent, prompt chỉ đưa đường dẫn `.claude/plans/<nhánh>.md`, thay vì code
tiếp trong session đã chật.

## 3. Implement
- Task trong queue: `npm run queue -- next` lấy task ready ưu tiên cao nhất, rồi
  `npm run queue -- start <id> --branch feat/<scope>-<mô-tả>` để claim: đánh dấu In progress **và** tạo
  nhánh + worktree trong một lệnh; task đã có người nhận hoặc còn blocker → script từ chối.
- Mỗi task một **worktree riêng**. Task ngoài queue: `npm run task -- feat/<scope>-<mô-tả>` (hoặc
  `fix/...`, tạo từ `dev`). Rồi `EnterWorktree(path=...)` theo đường dẫn script in ra.
  `npm run status` cho biết worktree nào đang có người làm. Session đã ở sẵn trong một worktree
  của task thì dùng nó. Chạy thẳng các lệnh này, không gọi skill `devflow:ship` ở pha này; lỗi khi
  tạo worktree → xem mục worktree trong skill `devflow:ship`.
- Task nhỏ: ngay sau khi vào worktree, ghi plan **đúng bản người dùng đã duyệt** (kể cả quyết định
  ma trận test; chép từ file plan mode nếu có) vào `.claude/plans/<nhánh>.md` (`/` đổi thành `-`),
  commit cùng nhánh. Task OpenSpec dùng artifact, không cần file này.
- Người dùng đồng ý có test: viết test trước từ bảng ví dụ / ca tái hiện bug (phải đỏ trước khi sửa).
- **1 task = 1 nhánh = 1 lần land.** Trong nhánh commit nhỏ theo từng bước của plan, Conventional
  Commits, scope = module.
- Nhánh > ~400 dòng (không tính test / generated) → đề xuất tách.

## 4. Verify
Chạy và đọc kết quả thật, không đoán:
- Trong lúc sửa: chỉ test liên quan (lệnh trong CLAUDE.md).
- Khi xong: `npm run check` — đúng gate của land (commitlint, hard-rules, lint / build / test theo vùng
  file trong `.devflow.json`), chạy cả trên thay đổi chưa commit. `hard-rules` in ERROR (chặn) và WARN
  (mở dòng đó, sửa nếu đúng là vi phạm). Gọi Bash với `timeout: 600000`. Gate cache theo nội dung: verifier
  và `land` sau đó không chạy lại nếu nội dung không đổi.
- Test không nằm trong gate (integration cần DB, E2E...) mà thay đổi chạm tới → chạy tay theo CLAUDE.md.
- **Chạy app thật** (mục "Chạy app / smoke" trong CLAUDE.md) khi thay đổi người dùng thấy được: chạy luồng
  vừa sửa, dán bằng chứng (output, response, ảnh chụp). Gate xanh chưa chứng minh tính năng chạy.

**Circuit breaker:** sửa cùng một lỗi 2 lần mà vẫn đỏ → dừng, quay lại pha 2, báo người dùng root
cause đã biết và chưa biết. Không skip test, không nuốt exception.

## 5. Self-review (người viết ≠ người kiểm)
Sau pha 4 xanh, chạy liền các bước dưới và pha 6 (commit) + 7 (báo cáo) mà không chờ người dùng nhắc;
chỉ dừng khi verifier FAIL không tự sửa được, chạm circuit breaker, hoặc cần quyết định của người dùng.
Người dùng nhận **một** báo cáo cuối.
- Giao subagent **`devflow:verifier`** kiểm diff so với `.claude/plans/<nhánh>.md` hoặc
  `openspec/changes/<name>/`; prompt chỉ đưa đường dẫn, không chép lại plan. FAIL → sửa, chạy lại
  pha 4, gọi lại verifier.
- `/simplify` trên diff (gọn hoá, bỏ phần thừa), rồi `/code-review high`; `/security-review` nếu đụng auth, phân quyền, endpoint mới, upload, xử lý dữ liệu thật.
- Chỉ sửa finding ảnh hưởng đúng / sai hoặc yêu cầu; finding kiểu "nên thêm cho chắc" thì bỏ qua.

**Luật review (áp dụng cho cả `/code-review` và `/security-review`):**
1. **Tối đa 3 vòng.** Sau vòng 3 mà còn finding → dừng, gửi người dùng danh sách còn lại để duyệt; không tự lặp tiếp.
2. **Chỉ review diff mới.** Vòng 1 review cả diff nhánh; vòng 2–3 chỉ review `git diff <commit-vòng-trước>..HEAD`.
3. **Gom bug theo loại** (logic, transaction/DB, phân quyền, thiếu test, style); sửa cả nhóm trong một
   commit rồi mới review lại, không sửa lẻ từng finding.
4. **Không báo lại bug cũ.** Finding đã sửa, hoặc đã bỏ qua có lý do, không báo lại ở vòng sau; ghi danh
   sách đã xử lý ở vòng 1 và đối chiếu.

## 6. Commit và land (local, không PR; nhánh task không push)
- Commit bằng `npm run ship` (skill `devflow:ship`). Quyết định còn giá trị ghi vào body commit.
- Xoá file handoff và file plan (`.claude/plans/<nhánh>.md`) của nhánh trong một commit trước khi land.
- `npm run land` khi người dùng yêu cầu, hoặc khi plan đã duyệt chọn `auto-land` và đủ điều kiện (pha 2
  mục 7); gate đỏ → skill `devflow:steward`.
- `npm run promote` chỉ khi người dùng yêu cầu riêng.
- Sau khi land, đúng thứ tự: `npm run queue -- done <id>` (task trong queue) → `ExitWorktree(action="keep")`
  → từ repo chính `npm run untask -- <nhánh>` (**bắt buộc**: `land` chạy trong worktree nên không gỡ được chính
  nó; bỏ sót thì worktree và nhánh nằm lại) → task OpenSpec: `npm run archive -- <name>` (worktree
  `chore/archive-<name>` → `openspec archive -y` → commit → `check` → `land` → `untask`). Script từ chối (task
  chưa tick đủ, CLI báo lỗi spec) thì `/opsx:archive` trong subagent context sạch. Task đi bằng
  `devflow:opsx-run` không phải nhớ bước này: phiên chính ở lại repo chính, bước 6 tự `untask` + `archive`.
  Báo cáo cuối nêu rõ archive đã xong hay chưa.

Dừng giữa chừng (hết phiên, chờ người dùng, context sắp đầy) → `/devflow:handoff` trước khi dừng;
task trong queue thì thêm `npm run queue -- block <id> --reason "..."`.

## 7. Báo cáo
Thay cho mô tả PR, gửi trong chat: đã làm gì; **bằng chứng kiểm thử** (lệnh + dòng kết quả thật,
kết luận verifier); "Thay đổi DB" nếu có; rủi ro còn lại; việc người cần làm (đọc
`git diff dev...<nhánh>`, bảo land, chạy migration production, UAT).
Task lộ ra bài học mới → đề xuất thêm vào "Bài học đã rút ra" của `CLAUDE.md`.
