---
name: ship
description: Local git flow of a devflow repo — worktree per task, commit only the task's files, gate + fast-forward the task branch into dev, fast-forward dev into main with a version tag, auto-push dev/main/tags to the backup remote — all through scripts/devflow/flow.mjs. No PR, no CI. Use when starting a code task (dev-loop phase 3) and for every git step after the code is done, or when the user says "ship", "commit", "land", "merge", "promote", "release", "lên main".
---

# ship

Repo chạy **local**: clone này là nguồn sự thật, không PR, không CI. Remote (mặc định `origin`) chỉ là
bản sao lưu: script tự push `dev`, `main` và tag sau `land` / `promote`. Nhánh task không bao giờ được
push. Tên nhánh, remote, gate: `.devflow.json` (mặc định `dev` → `main`).

```
feat/… fix/… chore/…  ──land (gate + ff)──►  dev  ──promote (ff + tag vX.Y.Z)──►  main
                                              │                                    │
                                              └──── push remote (sao lưu) ─────────┘
```

Mọi bước git đi qua `scripts/devflow/flow.mjs` (qua `npm run <lệnh>`; repo không có `package.json`
thì `node scripts/devflow/flow.mjs <lệnh>`). Không tự gõ `git merge`/`git rebase` lên `dev`/`main`,
`git worktree add/remove`, hay `git push` (hook chặn). Thêm `--dry-run` để chỉ in các bước sẽ làm.

## Mỗi task / session một worktree

Thư mục repo chính dùng chung: hai session sửa cùng một file thì git không tách được dòng nào của ai.
Vì vậy mỗi task code làm trong worktree riêng.

1. Từ thư mục repo chính: `npm run task -- feat/<scope>-<mô-tả>` → tạo `.claude/worktrees/feat-<scope>-<mô-tả>`
   trên nhánh mới từ `dev` local, link sẵn các thư mục `linkDirs` (`node_modules`, `.husky/_`...).
2. Agent: `EnterWorktree(path="<đường dẫn script in ra>")`. Người: `cd` vào đó.
3. Code, test, `ship`, `land` đều chạy **trong worktree**.
4. Xong (đã land): `ExitWorktree(action="keep")`, rồi từ repo chính `npm run untask -- <nhánh>`.
   Không dùng `git worktree remove --force` hay `ExitWorktree(remove)`: phải gỡ link trước, `untask`
   làm việc đó và từ chối nếu worktree còn thay đổi chưa commit.

`ship` ở repo chính mà còn file thay đổi khác ngoài danh sách → dừng (có thể là của session khác).
Chỉ người dùng tự commit tay mới dùng `--shared-ok`; agent không tự thêm cờ này.

## Lệnh

| Lệnh | Làm gì |
|---|---|
| `npm run task -- <type>/<scope>-<mô-tả>` | Tạo worktree cho task từ `dev`. |
| `npm run ship -- (-m "<header>" [-m "<body>"]... \| -F msg.txt) [--verify] [--land] [--promote] <file>...` | Commit **chỉ** các file liệt kê trên nhánh hiện tại. Đang ở `dev` → tạo nhánh từ header trước. Ở `main` → từ chối. |
| `npm run check` | Chạy đúng gate của `land` (kể cả thay đổi chưa commit), không commit, không merge. |
| `npm run land` | Từ nhánh task: `dev` đã đi trước → tự rebase (conflict → abort, dừng); gate; fast-forward `dev`; push `dev` lên remote. |
| `npm run promote` | Fast-forward `main` lên `dev`; có commit `feat`/`fix`/`perf`/`revert`/breaking từ tag trước → annotated tag `vX.Y.Z` (release notes trong tag); push `dev`, `main`, tag. |
| `npm run sync` | Xoá nhánh local mà `dev` đã chứa hết commit (bỏ qua nhánh đang checkout ở worktree). |
| `npm run backup` | Push `dev`, `main`, mọi tag — chạy lại khi lần push tự động trước bị lỗi. |
| `npm run untask -- <nhánh>` | Gỡ worktree của task an toàn (từ repo chính); xoá nhánh nếu `dev` đã chứa nó. |

**Gate của `land`** (thay CI, chạy trên `dev...HEAD`):
- commitlint mọi commit `dev..HEAD` (khi đã cài `@commitlint/cli`).
- `scripts/devflow/hard-rules.mjs --strict`: luật cứng trên dòng thêm / xoá so với `dev`. ERROR chặn
  (disable / focus test, sửa version tay, luật ERROR của `.devflow.json`); WARN chỉ in ra để agent /
  verifier đọc (xoá test / assertion, secret viết cứng, luật WARN của dự án).
- Mỗi vùng trong `areas` của `.devflow.json` có file đổi: ESLint từng file (có lỗi hoặc số cảnh báo
  tăng so với `dev` → dừng), rồi các lệnh của vùng (build, unit test...).
- Đỏ → không merge gì, nhánh giữ nguyên (đã rebase thì vẫn ở trạng thái đã rebase).

`ship --verify` chạy phần lint / lệnh vùng trên các file sắp commit, trước khi commit.

`dev` và `main` chỉ đi tới bằng fast-forward: lịch sử thẳng, không merge commit. `promote` từ chối nếu
`main` có commit mà `dev` không có — báo người dùng, không tự xử lý.

Sao lưu: push thường, không bao giờ force. Push lỗi chỉ in cảnh báo — `dev`/`main` local vẫn đúng; báo
người dùng và chạy `npm run backup` sau. Remote bị lệch (non-fast-forward) → hỏi người dùng.

Version: tag do `promote` tạo là phiên bản thật. Bump theo Conventional Commits từ tag gần nhất trên
`main`: breaking → major, `feat` → minor, `fix`/`perf`/`revert` → patch; chỉ `chore`/`docs`/`test`/... → không tag.

## Việc của agent (chỉ những chỗ cần AI)
- **Chọn file:** liệt kê các file của task, kể cả artifact `openspec/changes/<name>/` của task.
- **Commit message:** Conventional Commits, scope = module, kèm dòng attribution theo system-reminder
  của phiên. Message nhiều dòng → ghi vào file trong scratchpad, truyền `-F <file>` (qua `npm run` trên
  Windows, xuống dòng trong `-m` làm mất các tham số phía sau). Quyết định quan trọng ghi vào body commit.
- **Gate đỏ:** theo skill `devflow:steward` — đọc output, sửa root cause, `ship` commit mới, `land` lại.
- `land` / `promote` chỉ chạy khi người dùng yêu cầu rõ trong phiên.

## Lỗi thường gặp
- `main checkout has other uncommitted changes`: chuyển sang worktree (`npm run task`).
- `no changes in <file>`: sai đường dẫn hoặc đã commit rồi.
- `no local dev branch`: tạo một lần `git branch dev main` (hỏi người dùng trước).
- `rebase of <nhánh> onto dev conflicts`: `git rebase dev`, sửa conflict, `git rebase --continue`, `land` lại.
- `could not fast-forward dev in <path>`: worktree đang checkout `dev` có thay đổi chưa commit — báo người dùng, không tự dọn.
- `main has commits that dev does not`: báo người dùng, không reset.
- `backup push failed`: kiểm tra mạng / SSH key; `npm run backup`. Bị từ chối non-fast-forward → báo người dùng.
