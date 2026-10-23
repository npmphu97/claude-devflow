<!-- devflow:start — section do plugin devflow sinh; sửa các ô <...> cho đúng dự án. Giữ ngắn: quy trình nằm trong skill, luật máy kiểm được nằm trong .devflow.json -->
## Quy trình (devflow)

Repo chạy local, không PR / CI: nhánh task → `npm run land` (gate + fast-forward) → `dev` → `npm run promote`
(+ tag `vX.Y.Z`) → `main`. Remote chỉ là bản sao lưu do script push. Chi tiết: skill `/devflow:dev-loop`,
`docs/AGENT_WORKFLOW.md`; cấu hình máy: `.devflow.json`.
- Task code: `/devflow:dev-loop` (tự chọn cỡ S / M / L). Fix nhỏ trên checkout `dev`: `/devflow:hot-fix-dev`.
- Mọi bước git qua `npm run task|ship|check|land|untask|archive` (skill `devflow:ship`); không `git push` / merge tay.
- `check` / `land` / `ship --verify`: Bash `timeout: 600000`; gate đỏ thì đọc file log nó in ra, đừng chạy lại.
- Phiên cloud (nhánh `ccr-*`): kết thúc bằng `npm run cloud-push`, không land.
- Land / promote chỉ khi người dùng bảo, hoặc plan đã duyệt chọn `auto-land`. Luôn `manual` khi đụng: schema /
  migration, phân quyền / bảo mật, tiền, sửa dữ liệu hàng loạt, <vùng riêng của dự án>.

## Lệnh build / test

<Compile, test liên quan (1 file / 1 test), toàn bộ unit test, integration test (cần DB, docker...), build, lint.
Baseline: số test, số đỏ, ngày. Verify không được làm tăng số test đỏ.>

## Kiểm app thật

Skill `verify-app` của dự án (`.claude/skills/verify-app/`, tạo / cập nhật bằng `/devflow:verify-setup`).
<Xoá mục này nếu dự án không có app chạy được.>

## OpenSpec

<Xoá mục này nếu dự án không dùng OpenSpec.> Tiêu chí chọn: skill `dev-loop` (cỡ L). Quy tắc nghiệp vụ người dùng
thấy được của dự án (đổi chúng là cỡ L): <ví dụ: cách tính tiền, lịch, điều kiện hợp lệ>.

## Cách viết thay đổi

- Nói giả định trước khi code; yêu cầu có nhiều cách hiểu thì hỏi, không tự chọn âm thầm.
- Ít code nhất đủ giải quyết; không thêm abstraction, cấu hình, xử lý lỗi ngoài yêu cầu.
- Chỉ sửa chỗ cần sửa: mỗi dòng đổi truy được về yêu cầu; thấy code chết không liên quan thì báo, không xoá.

## Luật cứng

Luật máy kiểm được nằm trong `rules` của `.devflow.json` (gate của `land` chạy) và hook của plugin (skip test,
push tay, dời `dev`/`main`). Ở đây chỉ ghi luật cần phán đoán:
1. Không commit mật khẩu / khoá thật.
2. <Luật riêng: schema / migration, transaction, kiến trúc layer, bảo mật, tiền tệ...>

## Quy ước

- Commit: Conventional Commits, scope = <tên module / package>. Nhánh: `feat|fix|chore/<scope>-<mô-tả>` từ `dev`.

## Bài học đã rút ra

1–2 dòng mỗi bài, kèm tháng. Chỉ ghi khi không đưa lên được rule / lint / test (bước "Bài học" của `dev-loop`).
<!-- devflow:end -->
