# Your Video Is Mine

Extension MV3 (Chrome/Edge) **phát hiện & tải video** về máy: HLS `.m3u8` (ưu tiên),
DASH `.mpd`, và progressive `.mp4/.webm/.m4v/.mov/.mkv/.ogg`. HLS được giải mã AES-128 (nếu có)
và ghép thành `.mp4` bằng **ffmpeg.wasm** chạy trong offscreen document.

> ⚠️ **Chỉ tải nội dung bạn có quyền.** Extension **KHÔNG** hỗ trợ nội dung được bảo vệ DRM
> (Widevine/FairPlay/PlayReady, hoặc SAMPLE-AES qua EME) và sẽ **dừng** khi phát hiện.

## Tính năng

- Phát hiện media qua **network** (webRequest), **DOM** (`<video>`/`<source>`), và **MSE/blob**
  (main-world hook — báo hiệu player ẩn URL).
- Liệt kê & chọn **chất lượng** HLS/DASH; nhớ chất lượng ưa thích.
- **Tải progressive** với đặt tên file thông minh + trạng thái + huỷ.
- **Tải & ghép HLS → .mp4**: fetch song song, giải mã AES-128, remux `-c copy`, tiến trình 2 pha,
  cảnh báo dung lượng, hàng đợi tuần tự, huỷ giữa chừng.
- **Bypass non-DRM**: spoof `Referer`/`Origin` vượt hotlink/403; bỏ chặn chuột phải/bôi chọn.
- Trang **Cài đặt**: thư mục tải, ngưỡng cảnh báo, số luồng, lọc loại media, chẩn đoán ffmpeg.

---

## 🚀 Cài đặt cho người dùng (không cần lập trình)

Extension chưa lên store nên cài theo kiểu **Load unpacked** (thủ công) — làm 1 lần, dùng mãi.

### Bước 1 — Tải bản build

- Vào tab **[Releases]** của repo → tải file `yourvideoismine-<phiên bản>-chrome.zip`.
- **Giải nén** file `.zip` ra một thư mục (nhớ đường dẫn, ví dụ `C:\Users\ban\your-video-is-mine`
  trên Windows, hoặc `~/your-video-is-mine` trên macOS).

### Bước 2 — Cài vào Microsoft Edge

1. Mở `edge://extensions`.
2. Bật **Developer mode** (Chế độ nhà phát triển) ở góc dưới bên trái.
3. Bấm **Load unpacked** (Tải tiện ích đã giải nén) → chọn **thư mục vừa giải nén** ở Bước 1.
4. Ghim icon extension lên thanh công cụ.

### Bước 2 (thay thế) — Cài vào Google Chrome

1. Mở `chrome://extensions`.
2. Bật **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked** → chọn thư mục đã giải nén.

> 💡 Windows & macOS thao tác giống hệt nhau (chỉ khác đường dẫn thư mục).
> Khi có bản mới: tải `.zip` mới, giải nén đè lên thư mục cũ, rồi bấm **Reload** ở trang extensions.

---

## 🎬 Cách dùng

1. Mở trang có video và **bấm play** (nhiều player chỉ nạp media khi bắt đầu phát).
2. Bấm **icon extension** → thấy danh sách media của tab đang mở (số trên icon là số media phát hiện).
3. Tuỳ loại:
   - **MP4 (progressive)**: bấm **Tải xuống**.
   - **HLS / DASH**: bấm **Chất lượng** để xem các mức; với **HLS** chọn mức rồi bấm **Tải .mp4**
     (extension sẽ tải các đoạn, giải mã nếu cần, và ghép lại thành 1 file `.mp4`).
4. Video lớn: extension **cảnh báo trước** (ngưỡng chỉnh trong trang **Cài đặt**).
5. Trạng thái tải hiển thị ngay trong popup; có thể **Huỷ** giữa chừng.

**Cài đặt** (chuột phải icon → Options): thư mục lưu, ngưỡng cảnh báo dung lượng, số luồng tải,
lọc loại media hiển thị, và nút **Kiểm tra ffmpeg**.

---

## 🛠 Cài đặt từ mã nguồn (cho lập trình viên)

Yêu cầu: **Node.js LTS (≥ 20)** và **pnpm (≥ 9)**. Chạy được trên **Windows / macOS / Linux**.

```bash
pnpm install     # cài deps + tự đóng gói ffmpeg core (~30MB) vào public/ffmpeg/
pnpm dev         # chạy dev + hot-reload (mở trình duyệt dev)
pnpm build       # build production -> .output/chrome-mv3
pnpm zip         # đóng gói .zip để phát hành
```

Load bản dev/build: mở `edge://extensions` (hoặc `chrome://extensions`) → Developer mode →
**Load unpacked** → chọn `.output/chrome-mv3/`.

> **Windows:** dùng PowerShell hoặc CMD; các lệnh `pnpm ...` hoạt động như nhau, không cần chỉnh gì.

### Lệnh kiểm tra chất lượng

```bash
pnpm compile     # tsc --noEmit (kiểm kiểu)
pnpm lint        # eslint
pnpm test        # vitest (unit test: detect/hls/dash/crypto/dnr/filename/storage)
```

## Stack

WXT + TypeScript (strict) + React · `m3u8-parser`/`mpd-parser` · `@ffmpeg/ffmpeg` (single-thread)
· WebCrypto (AES-128) · declarativeNetRequest.

## Phạm vi & pháp lý

- Chỉ dùng cho nội dung bạn có quyền tải xuống. Tôn trọng bản quyền và điều khoản dịch vụ.
- **Không** hỗ trợ vượt DRM/EME; tính năng spoof header chỉ ở mức KHÔNG-DRM (hotlink/403).
- Xem [`docs/TESTING.md`](docs/TESTING.md) (ma trận test + giới hạn) và
  [`docs/PUBLISH.md`](docs/PUBLISH.md) (phát hành store). Đóng góp: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Giấy phép

[MIT](LICENSE).

[Releases]: ../../releases
