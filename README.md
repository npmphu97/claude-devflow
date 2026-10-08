# devflow — Claude Code plugin cho luồng làm việc local

Đóng gói workflow, scripts, skills, agents và hooks thành một plugin dùng được cho
mọi dự án dev local: mỗi task một worktree, gate local thay CI, `dev`/`main` chỉ fast-forward, tag
phiên bản tự sinh, verifier độc lập, ghi chú handoff, số liệu retro, hook chặn lệnh nguy hiểm.

## Cài đặt (một lần trên máy)

Trong Claude Code:

```
/plugin marketplace add C:\Users\npmph\Development\Projects\claude-devflow
/plugin install devflow@devflow-local
```

Sau khi sửa plugin: `/plugin marketplace update devflow-local`, rồi trong từng dự án `/devflow:init`
(chế độ cập nhật) để làm mới `scripts/devflow/`.

Cần: git, Node ≥ 18.

## Gắn vào một dự án

Trong thư mục dự án: `/devflow:init`. Skill chạy `install.mjs` (thử bằng `--dry-run` trước), hỏi vài
quyết định, rồi:

| Tạo / sửa | Nội dung |
|---|---|
| `scripts/devflow/*.mjs` | Script vendor vào dự án (gate chạy cả khi không có Claude, khoá version theo dự án) |
| `.devflow.json` | Cấu hình: nhánh, remote sao lưu, vùng gate (dò từ `package.json`, `pom.xml`, Gradle, Python, Go, Rust, .NET), luật cứng |
| `package.json` | `npm run task / ship / check / land / promote / sync / backup / untask / hard-rules / retro / handoff` |
| `CLAUDE.md` | Section quy trình (OpenSpec khi nào, bảng ví dụ, thiết kế test, luật cứng, bài học) giữa `<!-- devflow:start/end -->` |
| `docs/AGENT_WORKFLOW.md` | Các pha, circuit breaker, thang tin cậy |
| `.gitignore` | `.claude/worktrees/`; tự re-include `CLAUDE.md`, `.claude/`, `openspec/` nếu global excludesFile đang ignore chúng |
| `commitlint.config.cjs`, `.husky/commit-msg` | Conventional Commits |
| nhánh `dev` | Tạo từ `main` khi chọn `--create-dev` |

Không ghi đè file đã có. OpenSpec là tuỳ chọn (`openspec init --tools claude` + template `kit/templates/openspec-config.yaml`).

## Thành phần plugin

| Loại | Tên | Vai trò |
|---|---|---|
| Skill | `/devflow:init` | Gắn / cập nhật devflow trong repo |
| Skill | `/devflow:dev-loop` | Một task qua đủ pha: intake → phân loại → analyze → plan (người duyệt) → implement → verify → self-review → land |
| Skill | `devflow:ship` | Luồng git local qua `scripts/devflow/flow.mjs` |
| Skill | `devflow:steward` | Gate đỏ, review, những việc không bao giờ làm |
| Skill | `/devflow:handoff` | Ghi chú resume ≤ 30 dòng trên nhánh |
| Skill | `/devflow:retro` | Số liệu từ git + đề xuất luật gate / bài học |
| Agent | `devflow:verifier` | Kiểm diff so với plan trong context mới, kết luận PASS/FAIL |
| Agent | `devflow:ba` | Hỏi yêu cầu, viết spec (OpenSpec hoặc plan) — không code |
| Hook | SessionStart | In ghi chú handoff của nhánh; chạy `remoteSetup` trong cloud session |
| Hook | PreToolUse (Bash, PowerShell) | Chặn skip test, `git push` tay, `gh pr/release/run`, dời `dev`/`main`, SQL phá dữ liệu, `rm -rf /` |

Hook chỉ hoạt động trong repo có `.devflow.json` — cài plugin không đổi hành vi ở dự án khác.

## Luồng git

```
feat/… fix/… chore/…  ──land (gate + ff)──►  dev  ──promote (ff + tag vX.Y.Z)──►  main
                                              │                                    │
                                              └──── push remote (sao lưu) ─────────┘
```

Gate của `land` / `check`: commitlint `dev..HEAD` → `hard-rules --strict` → với mỗi vùng có file đổi:
ESLint từng file (lỗi hoặc tăng cảnh báo so với `dev` → chặn) rồi các lệnh của vùng.

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

## Không đóng gói

- `brainstorming` (từ plugin superpowers) — cài plugin đó nếu cần.
- Skill / command OpenSpec — do `openspec init --tools claude` sinh theo version CLI.
