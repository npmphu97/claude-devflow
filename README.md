# devflow — Claude Code plugin cho luồng làm việc local

Đóng gói workflow, scripts, skills, agents và hooks của `tutoring-hub` thành một plugin dùng được cho
mọi dự án dev local: mỗi task một worktree, gate local thay CI, `dev`/`main` chỉ fast-forward, tag
phiên bản tự sinh, verifier độc lập, ghi chú handoff, số liệu retro, hook chặn lệnh nguy hiểm.

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

## Gắn vào một dự án

Trong thư mục dự án: `/devflow:init`. Skill chạy `install.mjs` (thử bằng `--dry-run` trước), hỏi vài
quyết định, rồi:

| Tạo / sửa | Nội dung |
|---|---|
| `scripts/devflow/*.mjs` | Script vendor vào dự án (gate chạy cả khi không có Claude, khoá version theo dự án) |
| `.devflow.json` | Cấu hình: nhánh, remote sao lưu, vùng gate (dò từ `package.json`, `pom.xml`, Gradle, Python, Go, Rust, .NET), luật cứng |
| `package.json` | `npm run task / ship / check / land / promote / sync / backup / cloud-push / untask / worktrees:clean / hard-rules / retro / handoff / queue / status / doctor / devflow-test` |
| `CLAUDE.md` | Section quy trình (OpenSpec khi nào, bảng ví dụ, thiết kế test, luật cứng, bài học) giữa `<!-- devflow:start/end -->` |
| `docs/AGENT_WORKFLOW.md` | Các pha, circuit breaker, thang tin cậy |
| `.claude/task-queue.md` | Hàng đợi việc chung (skill `/devflow:queue`): In progress / Ready / Waiting / Done. Ở main checkout, gitignore — mọi worktree dùng chung một bản |
| `.claude/settings.json` | `plansDirectory` = `.claude/plans` (plan nằm trong repo, không ở `~/.claude/plans/`) + `permissions.allow` cho các lệnh local an toàn (`npm run check / ship / task / queue / status ...`; không gồm `land` / `promote`). Có file rồi → chỉ in gợi ý |
| `.gitignore` | `.claude/worktrees/`, `.claude/task-queue.md*`; tự re-include `CLAUDE.md`, `.claude/`, `openspec/` nếu global excludesFile đang ignore chúng |
| `commitlint.config.cjs`, `.husky/commit-msg` | Conventional Commits |
| nhánh `dev` | Tạo từ `main` khi chọn `--create-dev` |

Không ghi đè file đã có. OpenSpec là tuỳ chọn (`openspec init --tools claude` + template `kit/templates/openspec-config.yaml`).

## Thành phần plugin

| Loại | Tên | Vai trò |
|---|---|---|
| Skill | `/devflow:init` | Gắn / cập nhật devflow trong repo |
| Skill | `/devflow:dev-loop` | Một task qua đủ pha: intake → phân loại → analyze → plan (người duyệt) → implement → verify → self-review → land |
| Skill | `/devflow:opsx-run` | Chạy trọn một change OpenSpec đã duyệt artifact: worktree → apply (subagent) → check → verifier → review → commit → land theo chế độ `auto-land` / `manual` → archive (subagent) → một báo cáo cuối |
| Skill | `/devflow:hot-fix-dev` | Fix nhỏ làm thẳng trên checkout `dev` (không worktree) qua `ship --verify --land`; gate vẫn chạy, file lạ của session khác không bị đụng |
| Skill | `devflow:ship` | Luồng git local qua `scripts/devflow/flow.mjs` |
| Skill | `devflow:steward` | Gate đỏ, review, những việc không bao giờ làm |
| Skill | `/devflow:handoff` | Ghi chú resume ≤ 30 dòng trên nhánh |
| Skill | `/devflow:retro` | Số liệu từ git + đề xuất luật gate / bài học |
| Skill | `/devflow:queue` | Hàng đợi việc chung (`.claude/task-queue.md` ở main checkout): thêm task, task ready (hết blocker), claim = In progress + nhánh/worktree (`start --branch`), park / `unblock`, done khi land |
| Agent | `devflow:verifier` | Kiểm diff so với plan trong context mới, kết luận PASS/FAIL |
| Hook | SessionStart | In ghi chú handoff của nhánh + tóm tắt queue (task của nhánh, số task ready, task kế); chạy `remoteSetup` trong cloud session và fetch `dev` về local (để `check` có nhánh mà so) |
| Hook | PreToolUse (Bash, PowerShell) | Chặn skip test, `git push` tay, `gh pr/release/run`, dời / merge / reset `--hard` lên `dev`/`main`, SQL phá dữ liệu, `rm -rf /` |

Hook chỉ hoạt động trong repo có `.devflow.json` — cài plugin không đổi hành vi ở dự án khác.

## Luồng git

```
feat/… fix/… chore/…  ──land (gate + ff)──►  dev  ──promote (ff + tag vX.Y.Z)──►  main
                                              │                                    │
                                              └──── push remote (sao lưu) ─────────┘
```

Gate của `land` / `check`: commitlint `dev..HEAD` → `hard-rules --strict` → với mỗi vùng có file đổi:
ESLint từng file (lỗi hoặc tăng cảnh báo so với `dev` → chặn) rồi các lệnh của vùng.

## Chạy song song nhiều task

Mỗi task: một session + một nhánh + một worktree. Claim bằng `npm run queue -- start T-001 --branch feat/x-y`
(đánh dấu In progress và tạo worktree; claim trùng bị từ chối). `npm run status` in mỗi worktree task: nhánh,
`+ahead/-behind` so với `dev`, số file chưa commit, có handoff không, task queue tương ứng, rồi 3 task ready đầu.
Xong: `land → queue done → untask → (/opsx:archive trong subagent)`.

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
    "commands": [{ "label": "build", "cwd": "web", "run": "npm run build", "runWin": "..." }]
  }],
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
