# Đóng góp

Cảm ơn bạn quan tâm dự án! Vài quy ước để giữ codebase sạch.

## Môi trường

- Node.js LTS (≥ 20), pnpm (≥ 9).
- `pnpm install` (tự đóng gói ffmpeg core vào `public/ffmpeg/`).

## Quy trình

1. Tạo nhánh `feat/<tên>` / `fix/<tên>` / `docs/<tên>` từ `main`.
2. Code + thêm/cập nhật unit test cho logic thuần (`utils/`).
3. Chạy đủ cổng chất lượng trước khi mở PR:
   ```bash
   pnpm compile   # tsc --noEmit
   pnpm lint      # eslint
   pnpm test      # vitest
   pnpm build     # wxt build
   ```
4. Commit theo **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`...).
5. Mở PR vào `main`; CI phải xanh.

## Nguyên tắc kỹ thuật (bắt buộc)

- **MV3 service worker ephemeral**: không dùng biến toàn cục cho state — dùng `chrome.storage`.
- **ffmpeg.wasm + createObjectURL** chỉ ở offscreen; core single-thread, load local (không CDN).
- **Không** hỗ trợ DRM/EME. Phát hiện EME/SAMPLE-AES thì DỪNG.
- TypeScript strict, tách logic thuần ra `utils/` để test.

## Phát hành

- Bump version trong `package.json` + cập nhật `CHANGELOG.md`.
- Tạo tag `vX.Y.Z` và push → workflow `Release` tự build và tạo GitHub Release kèm file `.zip`.
