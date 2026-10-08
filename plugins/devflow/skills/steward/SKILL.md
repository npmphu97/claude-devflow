---
name: steward
description: Conventions for taking a finished task branch of a devflow repo through the local land gate into dev, and dev into main — what to do when the gate is red, how to handle review feedback, and what never to do. Use when the land gate fails, when the user reviews a diff, or before running land / promote.
---

# steward

Quy ước khi agent đưa một nhánh task vào `dev` (và `dev` vào `main`). Repo chạy local: không PR,
không CI — gate của `npm run land` (skill `devflow:ship`) là cổng kiểm duy nhất bằng máy.

## Gate đỏ
- Đọc output của bước đỏ, tái hiện bằng `npm run check` (cùng gate, không merge), sửa root cause,
  `ship` commit mới, `land` lại.
- `hard-rules` ERROR: sửa vi phạm; chắc là báo nhầm (ví dụ comment bị nhận nhầm là code) → báo người
  dùng và đề xuất sửa luật trong `.devflow.json` (hoặc `rulesModule`), không lách.
- Unit test đỏ: kiểm tra trước xem có phải do thứ tự test hay dữ liệu / mock dùng chung không.
- Test cần DB đỏ: kiểm tra trước xem có phải do schema của DB test lệch với code không.
- ESLint "warnings increased": sửa cảnh báo mới trong file đó; không tắt rule bằng comment để qua gate
  trừ khi người dùng đồng ý.
- `commitlint` đỏ: commit sai định dạng do mình tạo trên nhánh task → sửa bằng commit mới hợp lệ hoặc,
  khi người dùng đồng ý, rebase sửa message trên nhánh task. Không bao giờ sửa lịch sử `dev`/`main`.
- Rebase conflict khi `land`: sửa conflict trên nhánh task; conflict chạm logic người khác viết → hỏi.
- Không skip / disable test, không thêm cờ bỏ qua test.

## Review
Không có PR: người dùng đọc diff (`git diff dev...<nhánh>`) và báo cáo pha 7 của `devflow:dev-loop`
(bằng chứng kiểm thử, kết luận verifier) trước khi bảo land.
- Nit, đổi tên, thêm test, refactor nhỏ trong một hàm → tự sửa, commit mới.
- Thay đổi thiết kế, schema, API, xử lý dữ liệu thật → trả lời bằng đề xuất, chờ người quyết.

## Không bao giờ
- Tự `land` hoặc `promote` khi người dùng **chưa yêu cầu rõ** trong phiên này. Khi được yêu cầu: chỉ
  dùng `npm run land` / `npm run promote`, không merge / rebase tay lên `dev`/`main`, không land khi
  gate chưa xanh.
- Tự gõ `git push` (nhất là nhánh task), force-push, mở PR, hay gọi `gh pr|release|run` — sao lưu do
  `land` / `promote` / `npm run backup` lo.
- Tự chạy script sửa dữ liệu trên production.
- Sửa version trong file build (phiên bản là tag do `promote` tạo).

## Xong khi
Gate xanh, verifier PASS, báo cáo đã gửi người dùng — chờ người dùng bảo land (hoặc, nếu đã được yêu
cầu, chạy `npm run land`, rồi `untask`).
