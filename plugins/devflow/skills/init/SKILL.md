---
name: init
description: Set up the devflow local workflow in the current git repo — vendor scripts/devflow (git flow, land gate, hard rules, retro, handoff), draft .devflow.json from the detected stack, add npm scripts, the CLAUDE.md workflow section, commitlint + husky, a dev branch and optionally OpenSpec. Also refreshes vendored scripts after a plugin update. Use when the user says "devflow init", "set up devflow / the workflow in this repo", or a devflow skill finds no .devflow.json.
---

# init

Gắn bộ devflow vào repo hiện tại. Phần máy móc do `install.mjs` (cạnh SKILL.md này) làm; agent
duyệt bản nháp cấu hình với người dùng. Không ghi đè file đã có.

Đường dẫn script: `${CLAUDE_PLUGIN_ROOT}/skills/init/install.mjs`. Biến chưa được thay → tìm bằng
Glob `**/devflow/skills/init/install.mjs` dưới `~/.claude/plugins/`.

## Cập nhật (repo đã có devflow)
`node <install.mjs> --update` chỉ làm mới `scripts/devflow/*.mjs` theo bản plugin hiện tại. Đọc diff
(`git diff scripts/devflow`), báo người dùng, rồi xử lý các dòng `!` script in ra:
- **Section CLAUDE.md dài hơn mẫu** (trước 0.10 là ~130 dòng): đề xuất thay bằng mẫu mới
  `${CLAUDE_PLUGIN_ROOT}/kit/templates/CLAUDE.devflow.md`, **giữ nguyên phần dự án đã điền** (lệnh build / test,
  luật riêng, vùng buộc `manual`, ví dụ quy tắc nghiệp vụ, bài học). Phần chung đã chuyển vào skill `dev-loop`
  (`${CLAUDE_PLUGIN_ROOT}/skills/dev-loop/reference.md`). Trình diff cho người dùng duyệt trước khi ghi.
- `stopGate` / `areas[].format` chưa có trong `.devflow.json` → hỏi người dùng có bật không (mục 4 bên dưới).
- Chưa có `.claude/skills/verify-app/` và dự án có app chạy được → đề xuất `/devflow:verify-setup`.
Commit `chore(devflow): update scripts` qua `npm run ship`.

## Cài mới

1. **Kiểm tra trước:** đang ở gốc một repo git (chưa có thì hỏi người dùng có `git init` không),
   cây làm việc sạch (`git status`), có Node ≥ 18. Có `.devflow.json` rồi → chuyển sang "Cập nhật".
1.5. **Chọn chế độ:** repo có remote GitHub và muốn PR + CI (nhiều người, phiên cloud, GitHub Actions) → chế độ
   GitHub: thêm `--github` vào mọi lệnh install dưới đây (nhánh tích hợp = nhánh release, tức GitHub flow, trừ khi
   `--create-dev`; tạo `.github/workflows/devflow-gate.yml`; script `pr`, `release`). Không thì chế độ local.
2. **Chạy thử:** `node <install.mjs> --dry-run`. Trình người dùng: file sẽ tạo / giữ, vùng gate dò
   được, các cảnh báo `!`. Hỏi 1 lần các điểm cần quyết (dùng AskUserQuestion, có đề xuất):
   - Nhánh tích hợp `dev` chưa có → tạo từ nhánh release (`--create-dev`)?
   - Không có `package.json` ở gốc → tạo `package.json` private chỉ cho tooling (`--create-package-json`,
     cần cho commitlint / husky / `npm run`) hay chỉ dùng `node scripts/devflow/flow.mjs`?
   - Dùng OpenSpec cho task lớn không?
3. **Chạy thật:** `node <install.mjs> [--create-dev] [--create-package-json]`.
4. **Duyệt `.devflow.json` với người dùng** — đây là gate của `land`:
   - `areas[].commands`: chỉ lệnh **không tương tác, không cần dịch vụ ngoài** (unit test, build, lint).
     Test cần DB / trình duyệt → loại khỏi gate (filter của test runner), ghi lệnh chạy tay vào CLAUDE.md.
   - `areas[].eslint`: chỉ khi vùng đó có ESLint; gate chặn lỗi và chặn tăng cảnh báo so với `dev`.
   - `remote`: remote sao lưu (`null` nếu không muốn push).
   - `rules`: luật cứng riêng của dự án dò được bằng regex trên dòng thêm / xoá, ví dụ
     `{ "level": "ERROR", "files": "Controller\\.java$", "added": "^\\s*import\\s+[\\w.]+Repository;", "msg": "controller không gọi repository" }`.
     `unlessChanged` tắt luật khi có file khớp được đổi (ví dụ đổi entity mà đã có script migration).
     Luật cần logic → `rulesModule` (module JS tự viết, export default `rules({ files, add, root, isCode, readFile })`).
   - `areas[].format`: formatter mà hook PostToolUse chạy trên từng file vừa sửa (đường dẫn file nối vào cuối
     lệnh), ví dụ `{ "cwd": "web", "run": "npx --no-install prettier --write --ignore-unknown" }`. Script dò sẵn
     prettier / gofmt / ruff / black; thiếu thì hỏi người dùng dự án format bằng gì. Không có → bỏ trống.
   - `stopGate` (bản nháp: `true`): hook Stop không cho agent kết thúc lượt trên nhánh task khi nội dung chưa qua
     `check` (cache nên chỉ tốn thời gian một lần cho mỗi nội dung). Gate chậm (> vài phút) mà người dùng không
     muốn → `false`.
   - Repo dùng tên nhánh khác (ví dụ `develop` / `master`) → sửa `integrationBranch` / `releaseBranch`.
5. **Cài tooling** (khi có `package.json`, hỏi trước vì cần mạng):
   `npm i -D @commitlint/cli @commitlint/config-conventional husky`, `npm pkg set scripts.prepare=husky`,
   `npx husky` (không dùng `husky init`: nó tạo `pre-commit` chạy `npm test`). Hook `.husky/commit-msg`
   install.mjs đã viết.
6. **OpenSpec** (nếu chọn): `npx @fission-ai/openspec init --tools claude` (hoặc cài devDependency
   `@fission-ai/openspec`), rồi thay `openspec/config.yaml` bằng
   `${CLAUDE_PLUGIN_ROOT}/kit/templates/openspec-config.yaml` và điền các ô `<...>`. Không dùng → xoá mục
   "OpenSpec" trong section CLAUDE.md vừa thêm.
7. **CLAUDE.md:** điền các ô `<...>` của section devflow (lệnh build / test + baseline, vùng buộc `manual`, luật
   cứng riêng, scope commit). Giữ section ngắn: chỉ ghi điều agent không tự đọc ra từ code. Chưa có phần tổng quan
   / kiến trúc → đề xuất người dùng chạy `/init` của Claude Code.
7.5. **Kiểm app thật:** dự án có app chạy được → đề xuất chạy `/devflow:verify-setup` ngay (tạo skill
   `verify-app` của dự án); không có → xoá mục "Kiểm app thật" trong CLAUDE.md.
7.8. **Chế độ GitHub:** thêm vào `.github/workflows/devflow-gate.yml` các bước cài đặt mà lệnh của vùng cần
   (composer, docker, dịch vụ…); nhắc người dùng đặt check "devflow gate" thành required trong branch protection của
   nhánh tích hợp và chọn kiểu merge (merge commit hoặc squash với tiêu đề PR theo Conventional Commits để `release`
   tính được version).
8. **Kiểm chứng:** `npm run doctor` (repo sẵn sàng: nhánh, tooling gate, hook), rồi `npm run check`
   trên nhánh hiện tại (gate phải chạy được, xanh hoặc đỏ có lý do rõ), `npm run hard-rules`.
9. **Commit** (hỏi trước): tạo worktree / nhánh `chore/devflow-setup`, commit bằng
   `npm run ship -- -m "chore(devflow): set up local workflow" <các file vừa tạo / sửa>`; land khi người dùng bảo.

## Báo cáo
File đã tạo / sửa, vùng gate và lệnh của từng vùng, luật đã thêm, kết quả `npm run check`, việc người
dùng còn phải làm (điền CLAUDE.md, tạo remote sao lưu...).
