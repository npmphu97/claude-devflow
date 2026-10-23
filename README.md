# devflow — Claude Code plugin cho luồng làm việc local

Đóng gói workflow, scripts, skills, agents và hooks của `tutoring-hub` thành một plugin dùng được cho
mọi dự án dev local: mỗi task một worktree, gate local thay CI, `dev`/`main` chỉ fast-forward, tag
phiên bản tự sinh, verifier độc lập, skill `verify-app` riêng của dự án để kiểm app thật, ghi chú handoff, số
liệu retro, hook chặn lệnh nguy hiểm / format file vừa sửa / không cho kết thúc lượt khi chưa qua gate.

Nguyên tắc (đối chiếu best practices của Anthropic, cách Boris Cherny dùng Claude Code, pstack của Lauren Tan):
cho agent cách **tự kiểm chứng** (gate, `verify-app`, verifier context mới); **người viết ≠ người kiểm**; quy trình
nằm trong skill, CLAUDE.md giữ ngắn; luật máy kiểm được thì giao cho máy (rule, hook) thay vì viết thành lời; độ
nặng của quy trình theo cỡ task (S / M / L).

## Cài đặt (chỉ local, không đưa lên đâu cả)

Cần: git, Node ≥ 18.

"Marketplace" ở đây chỉ là **thư mục này trên máy**: `.claude-plugin/marketplace.json` là danh mục để
Claude Code biết trong thư mục có plugin nào. Không có gì được upload hay công khai, repo cũng không
cần remote.

### Cách 1: cài cố định từ thư mục local (nên dùng)

Trong Claude Code:

```
/plugin marketplace add C:\Users\npmph\Development\Projects\pnptech\claude-devflow
/plugin install devflow@devflow-local
```

- Plugin có sẵn trong mọi session, mọi dự án. Hook chỉ chạy ở repo có `.devflow.json`.
- Sau khi sửa plugin: `/plugin marketplace update devflow-local`, rồi khởi động lại Claude Code.
- Gỡ: `/plugin uninstall devflow@devflow-local`.

### Cách 2: nạp cho từng lần chạy, không cài gì

```
claude --plugin-dir C:\Users\npmph\Development\Projects\pnptech\claude-devflow\plugins\devflow
```

- Chỉ có hiệu lực trong session đó; lần sau phải gõ lại cờ này.
- Hợp khi đang sửa plugin và muốn thử ngay.

### Không khuyên dùng: copy tay vào `~/.claude/`

Copy từng skill vào `~/.claude/skills/` và khai báo hook trong `~/.claude/settings.json` cũng chạy được,
nhưng phải tự nối đường dẫn tới hook / script, agent không được nạp theo, và mỗi lần cập nhật lại phải
copy tay.

### Sau khi cài

Cách nào cũng dùng giống nhau: vào thư mục dự án, chạy `/devflow:init` một lần (xem mục dưới), rồi làm
việc bằng `/devflow:dev-loop`, `npm run land`... Plugin có bản mới → trong từng dự án chạy lại
`/devflow:init` (chế độ cập nhật) để làm mới `scripts/devflow/`.

### Nâng cấp lên 0.10

Trong từng dự án: `/devflow:init` (chế độ cập nhật). Script in các dòng `!` cần xử lý:

1. Section devflow trong `CLAUDE.md` còn bản cũ (~130 dòng) → thay bằng mẫu mới (~50 dòng), giữ phần dự án đã
   điền (lệnh build / test, luật riêng, vùng buộc `manual`, bài học). Phần chung đã chuyển vào skill `dev-loop`.
2. Thêm `"stopGate": true` vào `.devflow.json` (repo cũ mặc định tắt).
3. Thêm `format` cho các vùng có formatter (prettier, gofmt, ruff, black...).
4. Dự án có app chạy được → `/devflow:verify-setup` để tạo `.claude/skills/verify-app/`.

## Gắn vào một dự án

Trong thư mục dự án: `/devflow:init`. Skill chạy `install.mjs` (thử bằng `--dry-run` trước), hỏi vài
quyết định, rồi:

| Tạo / sửa | Nội dung |
|---|---|
| `scripts/devflow/*.mjs` | Script vendor vào dự án (gate chạy cả khi không có Claude, khoá version theo dự án) |
| `.devflow.json` | Cấu hình: nhánh, remote sao lưu, vùng gate (dò từ `package.json`, `pom.xml`, Gradle, Python, Go, Rust, .NET), luật cứng |
| `package.json` | `npm run task / ship / check / land / promote / sync / backup / cloud-push / untask / archive / worktrees:clean / hard-rules / retro / handoff / queue / status / doctor / devflow-test` |
| `CLAUDE.md` | Section ngắn (~50 dòng) giữa `<!-- devflow:start/end -->`: lệnh build / test, vùng buộc `manual`, luật cần phán đoán, quy ước, bài học. Quy trình chi tiết (tiêu chí OpenSpec, bảng ví dụ, ma trận test) nằm trong skill `dev-loop`, chỉ nạp khi dùng. Bản cũ dài hơn → `--update` nhắc thay |
| `docs/AGENT_WORKFLOW.md` | Các pha, circuit breaker, thang tin cậy |
| `.claude/task-queue.md` | Hàng đợi việc chung (skill `/devflow:queue`): In progress / Ready / Waiting / Done. Ở main checkout, gitignore — mọi worktree dùng chung một bản |
| `.claude/settings.json` | `plansDirectory` = `.claude/plans-draft` (bản nháp plan nằm trong repo, gitignored, không ở `~/.claude/plans/`; `.claude/plans/` chỉ chứa plan đã duyệt theo nhánh) + `permissions.allow` cho các lệnh local an toàn (`npm run check / ship / task / queue / status ...`; không gồm `land` / `promote`). Có file rồi → chỉ in gợi ý |
| `.gitignore` | `.claude/worktrees/`, `.claude/task-queue.md*`; tự re-include `CLAUDE.md`, `.claude/`, `openspec/` nếu global excludesFile đang ignore chúng |
| `commitlint.config.cjs`, `.husky/commit-msg` | Conventional Commits |
| nhánh `dev` | Tạo từ `main` khi chọn `--create-dev` |

Không ghi đè file đã có. OpenSpec là tuỳ chọn (`openspec init --tools claude` + template `kit/templates/openspec-config.yaml`).

## Thành phần plugin

| Loại | Tên | Vai trò |
|---|---|---|
| Skill | `/devflow:init` | Gắn / cập nhật devflow trong repo |
| Skill | `/devflow:dev-loop` | Một task: intake → **chọn cỡ S / M / L** (S: diff tả trong một câu, không plan, `check` rồi land; M: plan ngắn; L: OpenSpec) → analyze → plan (người duyệt) → implement → verify (gate + `verify-app`) → self-review (tối đa 3 vòng, từ vòng 2 chỉ review diff mới, gom finding theo loại) → land → **bài học** đặt ở tầng cao nhất (rule › lint/test › skill › CLAUDE.md) |
| Skill | `/devflow:verify-setup` | Tạo / cập nhật skill riêng của dự án `.claude/skills/verify-app/` (khởi động app, tài khoản, bản đồ tính năng + cách kiểm từng tính năng), chạy thử để chứng minh. `verify-app` chạy trong subagent, trả bằng chứng theo tính năng |
| Skill | `/devflow:opsx-run` | Chạy trọn một change OpenSpec đã duyệt artifact: worktree → apply (subagent) → check → verifier → review → commit → land theo chế độ `auto-land` / `manual` → untask + `npm run archive` → một báo cáo cuối. Phiên chính ở lại repo chính (lệnh trong worktree chạy bằng `npm --prefix`), nên sau khi duyệt artifact có thể `/clear` rồi chạy |
| Skill | `/devflow:hot-fix-dev` | Fix nhỏ làm thẳng trên checkout `dev` (không worktree) qua `ship --verify --land`; gate vẫn chạy, file lạ của session khác không bị đụng |
| Skill | `devflow:ship` | Luồng git local qua `scripts/devflow/flow.mjs` |
| Skill | `devflow:steward` | Gate đỏ, review, những việc không bao giờ làm |
| Skill | `/devflow:handoff` | Ghi chú resume ≤ 30 dòng trên nhánh |
| Skill | `/devflow:retro` | Số liệu từ git + đề xuất luật gate / bài học |
| Skill | `/devflow:queue` | Hàng đợi việc chung (`.claude/task-queue.md` ở main checkout): thêm task, task ready (hết blocker), claim = In progress + nhánh/worktree (`start --branch`), park / `unblock`, done khi land |
| Agent | `devflow:verifier` | Kiểm diff so với plan trong context mới, kết luận PASS/FAIL |
| Hook | SessionStart | In ghi chú handoff của nhánh + tóm tắt queue (task của nhánh, số task ready, task kế); chạy `remoteSetup` trong cloud session và fetch `dev` về local (để `check` có nhánh mà so) |
| Hook | PreToolUse (Bash, PowerShell) | Chặn skip test, `git push` tay, `gh pr/release/run`, dời / merge / reset `--hard` lên `dev`/`main`, SQL phá dữ liệu, `rm -rf /` |
| Hook | PostToolUse (Edit, Write) | Chạy formatter của vùng sở hữu file vừa sửa (`areas[].format`); lỗi formatter bị bỏ qua, gate vẫn lint |
| Hook | Stop | Khi `stopGate: true`: trên nhánh task, agent không kết thúc lượt khi nội dung hiện tại chưa qua `check` (đọc cùng cache với gate; chặn một lần mỗi lần dừng, nên dừng có chủ đích vẫn được) |

Hook chỉ hoạt động trong repo có `.devflow.json` — cài plugin không đổi hành vi ở dự án khác.

## Luồng git

```
feat/… fix/… chore/…  ──land (gate + ff)──►  dev  ──promote (ff + tag vX.Y.Z)──►  main
                                              │                                    │
                                              └──── push remote (sao lưu) ─────────┘
```

Gate của `land` / `check`: commitlint `dev..HEAD` → `hard-rules --strict` → với mỗi vùng có file đổi:
ESLint từng file (lỗi hoặc tăng cảnh báo so với `dev` → chặn) rồi các lệnh của vùng. Các vùng chạy song song,
tối đa `gate.maxParallel` (mặc định `0` = tất cả; `1` cho máy ít RAM). Output đầy đủ
ghi vào file log trong git dir; terminal chỉ in 1 dòng khi xanh, 60 dòng cuối khi đỏ. Cache theo nội dung
cây làm việc (kể cả chưa commit) + `dev`: `check` → verifier → `land` trên cùng nội dung chỉ chạy gate một lần.
Hook Stop (`stopGate`) đọc cùng cache: trên nhánh task, agent chưa được kết thúc lượt khi nội dung hiện tại chưa
qua `check`. Format không nằm trong gate: hook PostToolUse format từng file ngay khi agent sửa (`areas[].format`).

## Chạy song song nhiều task

Mỗi task: một session + một nhánh + một worktree. Claim bằng `npm run queue -- start T-001 --branch feat/x-y`
(đánh dấu In progress và tạo worktree; claim trùng bị từ chối). `npm run status` in mỗi worktree task: nhánh,
`+ahead/-behind` so với `dev`, số file chưa commit, có handoff không, task queue tương ứng, rồi 3 task ready đầu.
Xong: `land → queue done → untask → (OpenSpec: npm run archive -- <name>; script từ chối thì /opsx:archive trong subagent)`.

## Dọn worktree kẹt

`npm run untask` là đường chính để gỡ worktree sau khi land. Khi nó không được (thư mục còn sót sau
"Permission denied", ExitWorktree "No-op" vì worktree từ session cũ, thư mục git không còn biết),
dùng `npm run worktrees:clean` — chạy ở đâu cũng được, script tự về main checkout:

| Lệnh | Tác dụng |
|---|---|
| `npm run worktrees:clean` | Chỉ liệt kê mọi worktree / thư mục trong `.claude/worktrees`, đánh dấu ✔ an toàn hay ! rủi ro. Không đổi gì. |
| `npm run worktrees:clean -- --yes` | Xoá các mục an toàn: nhánh đã vào nhánh tích hợp và cây sạch, thư mục mồ côi, đăng ký worktree mà thư mục đã mất. Xoá luôn nhánh đã vào. |
| `... -- --yes <tên>` | Chỉ xử lý mục có tên nhánh / tên thư mục đó. |
| `... -- --yes --force` | Xoá cả mục rủi ro (còn thay đổi chưa commit hoặc nhánh chưa vào) — **mất việc chưa commit**. |

Script gỡ các junction/symlink (`node_modules`, `.husky/_`) trước khi xoá nên không xoá nhầm sang
main checkout. Đừng đứng terminal/IDE bên trong thư mục đang xoá (Windows khoá thư mục).

## `.devflow.json`

```jsonc
{
  "integrationBranch": "dev",          // nhánh tích hợp
  "releaseBranch": "main",             // nhánh release (tag vX.Y.Z)
  "remote": "origin",                  // remote sao lưu; null = không push
  "tagPrefix": "v",
  "worktreeDir": ".claude/worktrees",
  "linkDirs": ["node_modules", ".husky/_"],      // link từ checkout chính vào worktree
  "commitlint": "auto",                // "auto" | true | false
  "areas": [{
    "name": "web", "paths": ["web/"],
    "eslint": { "cwd": "web", "extensions": [".ts", ".html"] },
    "commands": [{ "label": "build", "cwd": "web", "run": "npm run build", "runWin": "..." }],
    "format": { "cwd": "web", "run": "npx --no-install prettier --write --ignore-unknown" }  // hook PostToolUse, nối đường dẫn file vào cuối
  }],
  "stopGate": true,                    // hook Stop: nhánh task phải qua `check` trước khi agent kết thúc lượt
  "versionFiles": ["package.json", { "file": "api/pom.xml", "type": "maven" }, { "file": "x.toml", "regex": "^version\\s*=" }],
  "testPaths": ["(^|/)tests?/", "\\.(spec|test)\\.[jt]sx?$"],   // nhận diện file test
  "rules": [{
    "level": "ERROR", "files": "Controller\\.java$", "added": "import .*Repository;",
    "msg": "controller không gọi repository",
    // tuỳ chọn: "removed", "flags", "newFilesOnly", "existingFilesOnly", "unlessChanged", "once", "skipComments"
  }],
  "rulesModule": "scripts/devflow-rules.mjs",    // luật cần logic: export default ({ files, add, root, isCode, isTest, readFile }) => {}
  "handoff": { "dir": ".claude/handoff", "openspecDir": "openspec/changes" },
  "retro": { "days": 7, "fixWindowDays": 7, "bigCommitLines": 400 },
  "guard": { "blockSkipTests": true, "blockManualPush": true, "blockGhPr": true, "blockBranchMoves": true, "blockDestructiveSql": true },
  "remoteSetup": ["npm install"]                 // chỉ chạy trong cloud session
}
```

Luật có sẵn (không cần cấu hình): disable / focus test (JUnit, Jest/Jasmine/Mocha, pytest, Go, Rust)
→ ERROR; sửa version tay trong `versionFiles` → ERROR; xoá test / bớt assertion → WARN; secret viết cứng → WARN.

## Ví dụ: tutoring-hub

`plugins/devflow/examples/tutoring-hub/` là `.devflow.json` + `devflow-rules.mjs` tái hiện đúng gate
và luật cứng hiện tại của tutoring-hub (đã so trên bản clone: cùng 4 ERROR / 6 WARN, cùng file:dòng).
Chuyển tutoring-hub sang plugin: copy hai file này, chạy `/devflow:init`, đổi `package.json` trỏ sang
`scripts/devflow/`, rồi xoá `scripts/git-flow.mjs`, `hard-rules.mjs`, `retro-stats.mjs`, `handoff.mjs`,
`.claude/skills/{dev-loop,ship,steward,handoff,retro}`, `.claude/agents/verifier.md`, `.claude/hooks/*`
(làm như một task `chore` riêng).

## Không đóng gói

- `brainstorming` (từ plugin superpowers) — cài plugin đó nếu cần.
- Skill / command OpenSpec — do `openspec init --tools claude` sinh theo version CLI.
