# Workflow agent loop (devflow)

Mỗi thay đổi đi qua đúng các bước một team IT chuẩn vẫn làm: tiếp nhận → phân tích → lập kế hoạch →
code → kiểm thử → review → land (gate) → promote → rút kinh nghiệm. Agent đổi "mũ" theo từng pha;
mỗi pha có đầu ra rõ ràng và cổng kiểm soát trước khi sang pha sau.

> **Repo chạy local:** không PR, không CI; remote chỉ giữ bản sao lưu `dev`/`main`/tag do script tự
> push. Nhánh task (không push) vào `dev` bằng fast-forward qua `npm run land` (gate local thay CI),
> `dev` vào `main` bằng fast-forward qua `npm run promote` (tạo tag `vX.Y.Z`).
>
> **Chế độ GitHub** (`"mode": "github"`): nhánh task được push và vào nhánh tích hợp bằng pull request — `npm run pr`
> (gate local + push + mở PR) → CI chạy cùng gate → người review và merge → `npm run sync`. Phát hành: `npm run release`
> (tag trên remote). Ở bảng dưới, "land" đọc là "pr + merge trên GitHub".

## Thành phần

| Thành phần | Vai trò |
|---|---|
| `CLAUDE.md` | Sổ tay dự án, giữ ngắn: lệnh build/test, luật cần phán đoán, quy ước, bài học. Quy trình nằm trong skill |
| `.devflow.json` | Cấu hình máy: tên nhánh, remote sao lưu, vùng gate (lint/build/test/format), luật cứng dò bằng regex, `stopGate` |
| `.claude/skills/verify-app/` | Skill của dự án: chạy app, bản đồ tính năng, cách kiểm từng tính năng (tạo bằng `/devflow:verify-setup`) |
| `scripts/devflow/*.mjs` | Phần máy móc, chạy không cần AI: luồng git, gate, hard-rules, retro, handoff |
| `.claude/task-queue.md` | Hàng đợi việc chung ở main checkout (không commit): làm gì, việc nào ready, việc nào đang chờ |
| Plugin `devflow` | Skill `dev-loop`, `opsx-run`, `hot-fix-dev`, `ship`, `steward`, `queue`, `handoff`, `retro`, `init`, `verify-setup`; agent `verifier`; hook chặn lệnh nguy hiểm, format file vừa sửa, chặn kết thúc lượt khi chưa `check` (`stopGate`), in ghi chú handoff và tóm tắt queue |

## Các pha

| Pha | Vai trò | Agent làm gì | Gate qua pha |
|---|---|---|---|
| 0. Intake | PO / BA | Đọc yêu cầu, hỏi lại chỗ mơ hồ, viết acceptance criteria "Khi … thì …" | Có tiêu chí rõ |
| 0.5. Chọn cỡ | Tech lead | S (diff một câu: không plan, `check` rồi land), M (plan ngắn), L (OpenSpec, tiêu chí trong `reference.md` của `dev-loop`); OpenSpec: propose trong worktree; `/opsx:apply` trong **subagent context sạch**, archive bằng `npm run archive` (skill `opsx-run`) | Nói rõ kết quả + lý do |
| 1. Analyze | BA + Tech lead | Explore code liên quan, test đang có, nơi dùng chung | Biết file nào bị ảnh hưởng |
| 2. Plan | Tech lead | Bước + cách kiểm, schema, transaction, dữ liệu cũ, ma trận test, rollback | **Người duyệt** |
| 3. Implement | Developer | Worktree riêng; task nhỏ lưu plan đã duyệt vào `.claude/plans/<nhánh>.md` cho verifier; commit nhỏ Conventional Commits | Compile sạch |
| 4. Verify | QA | Test liên quan, `npm run check`, skill `verify-app` khi đổi hành vi người dùng thấy | Gate xanh + bằng chứng |
| 5. Self-review | Reviewer | Subagent `verifier` (context mới), `/simplify`, `/code-review`, `/security-review` khi cần | verifier PASS (miễn khi chỉ đổi `.claude/`, `docs/`, `.md`) |
| 6. Báo cáo | Developer | `npm run ship`, báo cáo + bằng chứng thật trong chat; đề xuất bài học ở tầng cao nhất (rule › lint/test › skill › CLAUDE.md) | — |
| 7. Review | Người | Đọc `git diff dev...<nhánh>`; agent sửa theo góp ý (skill `steward`) | Người bảo land |
| 8. Land | Dev (khi được yêu cầu) | `npm run land`: rebase nếu cần, gate, fast-forward `dev`, push sao lưu | Gate xanh |
| 9. Promote | Release manager (người) | `npm run promote`: fast-forward `main`, tag `vX.Y.Z` | Deploy theo checklist |
| 10. Retro | Cả team | `/devflow:retro` → hook / luật gate / bài học CLAUDE.md | — |

Cỡ S bỏ pha 1–2 và phần lớn pha 5; cỡ M / L đi đủ.

**Nguyên tắc vàng:** agent tự động hoá pha 1, 3, 4, 5, 6. Pha 0, 2 (duyệt plan), 7 (review), 8–9
(land/promote) và mọi thao tác trên **dữ liệu production** luôn có người quyết định.

## Luật dừng (circuit breaker)

1. Sửa cùng một lỗi 2 lần mà test vẫn đỏ → dừng, quay lại pha 2, báo người dùng root cause đã biết / chưa biết.
2. Không bao giờ skip/disable test hay xoá assertion để cho xanh.
3. Không "fix" bằng `try/catch` nuốt lỗi; tìm root cause và ghi vào message commit.
4. Chạm dữ liệu production (data-tool, SQL tay) → luôn dừng chờ người duyệt.
5. Task phình quá phạm vi → dừng, đề xuất tách task mới.
6. Review quá 3 vòng mà còn finding → dừng, báo người dùng danh sách còn lại để duyệt. Từ vòng 2 chỉ review
   diff mới; gom finding theo loại, sửa một commit mỗi nhóm; không báo lại bug cũ.

## Thang tin cậy (autonomy slider)

Quyền tự chủ của agent tăng theo **bằng chứng**, không theo cảm giác.

| Nấc | Agent được làm | Người làm | Điều kiện lên nấc |
|---|---|---|---|
| 1. Kèm sát | Plan, code, test local, commit, báo cáo | Duyệt plan, đọc diff, bảo land | Gate chặn được lỗi lint/build/unit test |
| 2. Tự kiểm chứng | Như 1 + chạy app thật, dán bằng chứng | Đọc bằng chứng thay vì chạy lại | Có seed dữ liệu cho app local |
| 3. Việc nhỏ tự chạy | Task không cần OpenSpec chạy không kèm | Đọc diff + báo cáo | 4 tuần tỉ lệ fix-bám-feat giảm (`/devflow:retro`) |
| 4. Auto-land có điều kiện | Tự land (và archive) khi người dùng chọn `auto-land` lúc duyệt plan và gate + verifier + review sạch (không áp dụng cho schema, phân quyền, tiền/lương, công cụ sửa dữ liệu) | Soát lại trên `dev` trước khi promote | Bật theo từng task; theo dõi bằng `/devflow:retro` |

Việc đụng dữ liệu production, schema, phân quyền, tiền: **luôn ở nấc 1**.

## Dùng hằng ngày

| Tình huống | Lệnh |
|---|---|
| Bắt đầu task | `/devflow:dev-loop <mô tả>` |
| Lấy việc tiếp theo từ queue | `npm run queue -- next`, rồi `npm run queue -- start <id> --branch feat/<scope>-<mô-tả>` (claim + worktree) |
| Ai đang làm gì | `npm run status` |
| Xong một task | `npm run land` → `npm run queue -- done <id>` → `npm run untask -- <nhánh>` → (OpenSpec: `npm run archive -- <name>`; script từ chối thì `/opsx:archive` trong subagent) |
| Chạy trọn change OpenSpec đã duyệt | `/devflow:opsx-run <name>` (apply trong subagent, check → verifier → review → commit → land theo chế độ đã chọn → untask + archive; sau khi duyệt artifact có thể `/clear` rồi chạy) |
| Tính năng mới cần làm rõ yêu cầu | `/opsx:explore` rồi `/opsx:propose` |
| Fix nhỏ làm thẳng trên `dev` | `/devflow:hot-fix-dev` |
| Phiên cloud (nhánh `ccr-*`, `claude/*`) xong việc | Local: `npm run cloud-push` (chỉ backup, không land). GitHub: `npm run pr` |
| Kiểm trước khi land | `npm run check`, subagent `devflow:verifier`, skill `verify-app` của dự án |
| Dự án chưa có / cần cập nhật cách kiểm app thật | `/devflow:verify-setup` |
| Đưa nhánh vào `dev` / `dev` lên `main` | "land" (hoặc tự động nếu plan chọn `auto-land`) / "promote" |
| Dừng giữa chừng / tiếp tục | `/devflow:handoff` / `/devflow:handoff resume` |
| Hằng tuần, sau sự cố | `/devflow:retro` |

Chạy song song nhiều task: mỗi task một session + một worktree + một nhánh; không để hai agent cùng
sửa một module một lúc. Claim qua `queue start --branch` để hai session không nhận trùng; `npm run status`
xem toàn cảnh. Một session đi lạc thì bỏ worktree đó làm lại từ plan, rẻ hơn cố cứu.

## Chỉ số theo dõi
- Tỉ lệ commit `fix` bám một `feat` cùng scope trong 7 ngày (mục tiêu: giảm dần).
- Tỉ lệ dòng test / dòng code thay đổi (mục tiêu ≥ 20 %).
- Số lần test đỏ trên `dev`/`main` (mục tiêu: 0 — đã chặn ở gate của `land`).
