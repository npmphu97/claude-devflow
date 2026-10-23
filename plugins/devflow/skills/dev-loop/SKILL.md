---
name: dev-loop
description: Run one code task through the team workflow (intake → size S/M/L → analyze → plan → implement → verify → self-review → land → lesson, all local) in a repo set up with devflow (.devflow.json). Use when the user asks to build a feature, fix a bug, or change behavior.
---

# dev-loop

Quy trình chuẩn cho một task. Chọn cỡ trước, rồi làm tuần tự **các pha của cỡ đó**. Lý do từng pha:
`docs/AGENT_WORKFLOW.md`. Tiêu chí OpenSpec, bảng ví dụ, ma trận test, file plan: `${CLAUDE_SKILL_DIR}/reference.md`
(gọi tắt `reference.md` bên dưới; đọc mục cần khi được trỏ tới). Repo chưa có `.devflow.json` → đề xuất chạy `/devflow:init` trước.

## 0. Intake
- Đọc yêu cầu. Thiếu acceptance criteria, phạm vi (module, màn hình, vai trò) hoặc không rõ có đụng
  dữ liệu cũ không → hỏi lại người dùng, dừng tại đây.
- Viết lại acceptance criteria dạng "Khi … thì …", mỗi tiêu chí kèm **cách chứng minh xong** (test / lệnh /
  `verify-app`). Tiêu chí kiểm được thì agent tự lặp tới khi đạt; "làm cho chạy" thì không.
- Đổi quy tắc nghiệp vụ hoặc bug logic: lập **bảng ví dụ đầu vào → đầu ra** (`reference.md`).
- Nhánh đã có ghi chú handoff (hook SessionStart in ra) → `/devflow:handoff resume` trước.
- Việc mới cho backlog chung / task nhiều session / task có thể bị chờ →
  `npm run queue -- add --title "..." [--blocked-by T-..]` (skill `devflow:queue`).

## 0.5. Chọn cỡ — nói kết quả + lý do trong 1 dòng

| Cỡ | Khi nào | Các pha |
|---|---|---|
| **S** | Tả được diff trong **một câu**, ≤ ~3 file, nguyên nhân đã rõ, không đổi quy tắc nghiệp vụ / schema / API / phân quyền | Không plan mode, không file plan: nói 1 dòng "sửa gì, ở đâu, kiểm bằng gì" rồi làm. Đang ở checkout `dev` → `/devflow:hot-fix-dev`. Ngược lại: worktree (pha 3) → sửa → pha 4 → verifier chỉ khi đụng logic → pha 6–8 |
| **M** | Còn lại, không chạm tiêu chí OpenSpec | Đủ pha 1–8; plan ngắn trong chat |
| **L** | Chạm ít nhất một tiêu chí OpenSpec (`reference.md`), hoặc repo không có `openspec/` mà việc > 1 ngày / > ~8 file | Repo có `openspec/` → OpenSpec bên dưới. Không có → như M, plan chi tiết, implement trong subagent |

Vùng xám → hỏi người dùng, kèm đề xuất. Đang làm mà chạm điều kiện của cỡ lớn hơn → dừng, báo, chuyển cỡ.

**Cỡ L với OpenSpec:** `/opsx:explore` nếu cần làm rõ. Trước `/opsx:propose` tạo worktree:
`npm run task -- feat/<scope>-<name>`, **không** `EnterWorktree`: chạy `openspec` bằng `cd "<wt>" && openspec ...`,
ghi artifact bằng đường dẫn tuyệt đối trong `<wt>`, commit bằng `npm --prefix "<wt>" run ship`. Rồi
`/opsx:propose <tên-change>`. Artifact là plan của pha 2 — dừng chờ người duyệt. Sau khi duyệt chạy skill
**`devflow:opsx-run <name>`** (apply trong subagent → check → verifier → review → commit → land theo chế độ →
archive → một báo cáo). Không có công cụ `Agent` (phiên cloud, đang là subagent) → dừng sau khi duyệt, nhắc
người dùng mở phiên mới và gõ `/opsx:apply <name>`, rồi `/opsx:archive <name>` sau khi land.

## 1. Analyze (M, L)
- Giao subagent Explore tìm: module / file / component liên quan, test đang có, nơi khác dùng chung
  logic sẽ sửa (cái gì có thể vỡ ngoài diff). Giữ context chính cho việc code.

## 2. Plan (M, L — người phải duyệt)
Lập plan trong **plan mode** (chỉ đọc) và lặp với người dùng tới khi ổn. Chỉ trả lời câu áp dụng cho task:
0. Giả định đang dùng; yêu cầu có nhiều cách hiểu thì liệt kê và hỏi.
1. Các bước và file sẽ sửa, mỗi bước kèm cách kiểm (`bước → kiểm bằng gì`).
2. **Ranh giới:** code vượt ra ngoài một hàm → chốt trước type / interface / chữ ký hàm mới và module nào sở hữu
   chúng; hành vi API / sự kiện đổi thế nào với nơi gọi.
3. Schema / dữ liệu lưu trữ: có đổi gì mà công cụ migration của dự án không tự làm? Dữ liệu cũ cần chuyển đổi /
   dọn không (dry-run, idempotent, người xác nhận)?
4. Transaction / đồng thời: chỗ nào ghi dữ liệu, chỗ nào cần cô lập lỗi.
5. Ma trận test đề xuất (`reference.md`). Hỏi người dùng giữ, cắt, hay bỏ; ghi quyết định vào plan.
6. Rollback nếu release lỗi.
7. **Chế độ land** — đề xuất `auto-land` hoặc `manual` kèm lý do 1 dòng, người dùng chọn cùng lúc duyệt plan
   (OpenSpec: mục "Chế độ land" trong `design.md`; còn lại: trong `.claude/plans/<nhánh>.md`).
   - `auto-land`: sau khi `check` xanh, verifier PASS (hoặc được miễn) và không còn finding review chưa xử
     lý, agent tự `npm run land` rồi archive (nếu là OpenSpec), không chờ lời bảo.
   - `manual`: dừng sau báo cáo, chờ người dùng bảo land (lời bảo đó gồm cả archive).
   - **Buộc `manual`** khi task đụng các vùng liệt kê ở mục "Quy trình" của `CLAUDE.md` (schema / migration,
     phân quyền / bảo mật, tiền, sửa dữ liệu hàng loạt, vùng riêng của dự án), hoặc cần integration test mà chưa
     chạy được.
   - `promote` luôn do người dùng yêu cầu riêng, bất kể chế độ.

Chờ người dùng duyệt plan rồi mới code. Plan dài (cỡ L không OpenSpec): implement trong subagent, prompt chỉ đưa
đường dẫn `.claude/plans/<nhánh>.md`, thay vì code tiếp trong session đã chật.

## 3. Implement
- Task trong queue: `npm run queue -- next`, rồi `npm run queue -- start <id> --branch feat/<scope>-<mô-tả>`
  (claim + nhánh + worktree trong một lệnh; đã có người nhận hoặc còn blocker → script từ chối).
- Mỗi task một **worktree riêng**. Task ngoài queue: `npm run task -- feat/<scope>-<mô-tả>` (hoặc `fix/...`,
  tạo từ `dev`). Rồi `EnterWorktree(path=...)` theo đường dẫn script in ra. Session đã ở sẵn trong worktree của
  task thì dùng nó. Lỗi khi tạo worktree → mục worktree trong skill `devflow:ship`.
- Cỡ M / L (không OpenSpec): ngay sau khi vào worktree, ghi plan **đúng bản đã duyệt** (kể cả quyết định ma trận
  test; chép từ file plan mode nếu có) vào `.claude/plans/<nhánh>.md`, commit cùng nhánh.
- Người dùng đồng ý có test: viết test trước từ bảng ví dụ / ca tái hiện bug (phải đỏ trước khi sửa).
- **1 task = 1 nhánh = 1 lần land.** Commit nhỏ theo từng bước của plan, Conventional Commits, scope = module.
- Hook của plugin tự format file vừa sửa (`areas[].format` trong `.devflow.json`): không tự chạy formatter.
- Nhánh > ~400 dòng (không tính test / generated) → đề xuất tách.

## 4. Verify
Chạy và đọc kết quả thật, không đoán:
- Trong lúc sửa: chỉ test liên quan (lệnh trong CLAUDE.md).
- Khi xong: `npm run check` — đúng gate của land, chạy cả trên thay đổi chưa commit. `hard-rules` in ERROR
  (chặn) và WARN (mở dòng đó, sửa nếu đúng là vi phạm). Bash `timeout: 600000`. Gate cache theo nội dung:
  verifier và `land` sau đó không chạy lại nếu nội dung không đổi. Repo bật `stopGate` thì hook Stop không cho kết
  thúc lượt trên nhánh task khi nội dung hiện tại chưa qua `check`.
- Test không nằm trong gate (integration cần DB, E2E...) mà thay đổi chạm tới → chạy tay theo CLAUDE.md.
- **Kiểm app thật** khi thay đổi người dùng thấy được: skill `verify-app` của dự án (chạy trong subagent, trả
  về bằng chứng theo từng tính năng). Dự án chưa có skill đó → chạy luồng vừa sửa bằng tay, dán bằng chứng, và đề
  xuất `/devflow:verify-setup` trong báo cáo. Gate xanh chưa chứng minh tính năng chạy.

**Circuit breaker:** sửa cùng một lỗi 2 lần mà vẫn đỏ → dừng, quay lại pha 2, báo người dùng root
cause đã biết và chưa biết. Không skip test, không nuốt exception.

## 5. Self-review (người viết ≠ người kiểm)
Sau pha 4 xanh, chạy liền các bước dưới và pha 6–8 mà không chờ người dùng nhắc; chỉ dừng khi verifier FAIL
không tự sửa được, chạm circuit breaker, hoặc cần quyết định của người dùng. Người dùng nhận **một** báo cáo cuối.
- Giao subagent **`devflow:verifier`** kiểm diff so với `.claude/plans/<nhánh>.md` hoặc
  `openspec/changes/<name>/`; prompt chỉ đưa đường dẫn. Cỡ S: chỉ khi đụng logic, prompt đưa yêu cầu 1 dòng
  thay cho file plan. FAIL → sửa, chạy lại pha 4, gọi lại verifier.
- Cỡ M / L: `/simplify` trên diff, rồi `/code-review high`; `/security-review` nếu đụng auth, phân quyền,
  endpoint mới, upload, xử lý dữ liệu thật.
- Chỉ sửa finding ảnh hưởng đúng / sai hoặc yêu cầu; finding kiểu "nên thêm cho chắc" thì bỏ qua.

**Luật review (áp dụng cho cả `/code-review` và `/security-review`):**
1. **Tối đa 3 vòng.** Sau vòng 3 mà còn finding → dừng, gửi người dùng danh sách còn lại để duyệt.
2. **Chỉ review diff mới.** Vòng 1 review cả diff nhánh; vòng 2–3 chỉ `git diff <commit-vòng-trước>..HEAD`.
3. **Gom bug theo loại** (logic, transaction/DB, phân quyền, thiếu test, style); sửa cả nhóm trong một
   commit rồi mới review lại.
4. **Không báo lại bug cũ.** Finding đã sửa, hoặc đã bỏ qua có lý do, không báo lại ở vòng sau.

## 6. Commit và land (local, không PR; nhánh task không push)
- Commit bằng `npm run ship` (skill `devflow:ship`). Quyết định còn giá trị ghi vào body commit.
- Xoá file handoff và file plan (`.claude/plans/<nhánh>.md`) của nhánh trong một commit trước khi land.
- `npm run land` khi người dùng yêu cầu, hoặc khi plan đã duyệt chọn `auto-land` và đủ điều kiện (pha 2
  mục 7); gate đỏ → skill `devflow:steward`. `npm run promote` chỉ khi người dùng yêu cầu riêng.
- Sau khi land, đúng thứ tự: `npm run queue -- done <id>` (task trong queue) → `ExitWorktree(action="keep")`
  → từ repo chính `npm run untask -- <nhánh>` (**bắt buộc**: `land` chạy trong worktree nên không gỡ được chính
  nó) → task OpenSpec: `npm run archive -- <name>` (script từ chối thì `/opsx:archive` trong subagent context
  sạch). Task đi bằng `devflow:opsx-run` thì skill đó tự làm bước này. Báo cáo nêu rõ archive xong hay chưa.

Dừng giữa chừng (hết phiên, chờ người dùng, context sắp đầy) → `/devflow:handoff` trước khi dừng;
task trong queue thì thêm `npm run queue -- block <id> --reason "..."`.

## 7. Báo cáo
Thay cho mô tả PR, gửi trong chat: cỡ đã chọn; đã làm gì; **bằng chứng kiểm thử** (lệnh + dòng kết quả thật,
kết luận verifier, bằng chứng `verify-app`); "Thay đổi DB" nếu có; rủi ro còn lại; việc người cần làm (đọc
`git diff dev...<nhánh>`, bảo land, chạy migration production, UAT).

## 8. Bài học (ngay trong task, không đợi retro)
Trong task, người dùng phải sửa hướng agent, hoặc gate / verifier / review bắt được lỗi do agent gây ra mà có thể
lặp lại ở task sau → đề xuất **tối đa 2** bài học ở cuối báo cáo, mỗi cái đặt ở **tầng cao nhất làm được**:
1. Kiến trúc / type làm lỗi không viết ra được (đổi chữ ký, tách module) — thường là task riêng.
2. Luật máy: `rules` / `rulesModule` trong `.devflow.json`, rule lint, hoặc test hồi quy.
3. Skill của dự án: bổ sung `verify-app` (tính năng mới chưa có trong bản đồ), hoặc skill khác.
4. Một dòng trong "Bài học đã rút ra" của `CLAUDE.md` — chỉ khi 1–3 không làm được.

Kèm nội dung cụ thể (regex, dòng chữ, file). Chỉ sửa sau khi người dùng duyệt: commit trên nhánh task trước khi
land (`chore(devflow): ...` / `docs(claude): ...`), hoặc thành task riêng nếu đã land. Không có gì đáng rút → bỏ qua
mục này, không viết "không có bài học".
