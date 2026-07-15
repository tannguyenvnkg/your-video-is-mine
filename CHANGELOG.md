# Changelog

Mọi thay đổi đáng chú ý được ghi ở đây. Định dạng theo [Keep a Changelog], phiên bản theo [SemVer].

## [0.6.0] - 2026-07-15

### Thêm

- **Banner báo bản mới**: mở popup, nếu GitHub Releases có bản mới hơn bản đang cài thì hiện
  "Có bản mới vX.Y.Z" kèm nút **Tải về** mở thẳng trang Release. Tiện ích cài bằng load unpacked
  (không qua Web Store) nên **không tự cập nhật được** — banner chỉ báo để tải tay.
- `utils/version.ts`: so sánh **SemVer thuần** (`parseVersion`/`compareVersions`/`isUpdateAvailable`),
  bỏ tiền tố `v` của tag, xử lý đúng prerelease theo §11 — so chuỗi sẽ sai (`0.10.0` > `0.9.0`).
- `utils/update.ts`: gọi GitHub Releases API + **cache 6 giờ** trong `storage.local`
  (GitHub giới hạn 60 request/giờ/IP) — không gọi API mỗi lần mở popup.

### Ghi chú kỹ thuật

- Không cần quyền mới: `host_permissions` đã là `<all_urls>`, CSP không chặn `connect-src`.
- Cache lưu **tag thô** rồi so với version lúc render, nhờ vậy banner tự tắt ngay sau khi cập nhật
  (không chờ hết TTL). Dữ liệu từ mạng được kiểm kiểu và chỉ nhận link `https://github.com/`.
- Lỗi mạng/timeout/hết quota đều **im lặng** (giữ cache cũ, không hiện lỗi) — đây là tính năng phụ.
- Không gửi cookie sang API (`credentials: 'omit'`).

## [0.5.0] - 2026-07-15

### Thêm

- **Tiến trình tải HLS rõ ràng**: thay thông báo mơ hồ "Đang chuẩn bị…" bằng các giai đoạn cụ thể
  (nạp bộ xử lý → tải segment → ghép video → lưu file), kèm **phần trăm, tốc độ (MB/s), thời gian
  còn lại (ETA)** và thanh progress. ETA đếm ngược mượt nhờ tick 1 giây trong popup.
- **Badge % trên icon**: hiện tiến trình ngay trên icon tiện ích khi popup đóng; tự khôi phục về
  số lượng media đã phát hiện khi tải xong/lỗi/huỷ.
- **Thông báo hệ thống** khi tải xong hoặc gặp lỗi (quyền `notifications`).
- Tiến trình ghép video (`muxing`) nay hiện **% thật** từ sự kiện progress của ffmpeg (throttle 1%);
  tự chuyển sang thanh chạy vô định nếu ffmpeg chưa báo số.
- `utils/progress.ts`: helper thuần tính %/tốc độ/ETA + định dạng, có unit test.

### Tối ưu

- **Nạp ffmpeg.wasm song song với tải dữ liệu** thay vì nối đuôi: engine được prewarm ngay khi
  offscreen khởi tạo, và playlist/key AES/init segment tải đồng thời lúc engine đang nạp.
- **Prefetch segment có trần RAM**: tách khâu *tải* (mạng, song song) khỏi khâu *ghi* (FS ảo, cần
  ffmpeg) với backpressure `MAX_BUFFERED = min(2×luồng, 12)` segment — segment bắt đầu tải ngay
  trong lúc ffmpeg còn đang nạp, lấp khoảng "chết" ~2–4s mà KHÔNG giữ cả video trong bộ nhớ.
- Tiến trình đếm theo segment **tải xong** (đúng thứ người dùng chờ), giải phóng RAM ngay sau khi ghi.

### Sửa

- Bỏ log chẩn đoán (`[yvim]`/`[yvim-iso]`/`[yvim-bg]`) còn sót từ đợt điều tra phát hiện manifest —
  không còn log thừa ở console người dùng cuối. Logic hook sniff giữ nguyên.

## [0.4.1] - 2026-07-12

### Thêm

- **Sniff manifest HLS/DASH bị nguỵ trang**: hook `fetch`/`XMLHttpRequest` ở main world đọc
  ~256 byte đầu của response để nhận diện playlist thật (`#EXTM3U` → HLS, `<?xml`/`<MPD` → DASH)
  ngay cả khi URL/đuôi/`Content-Type` bị giả (vd segment `.ts` đặt tên `.jpg`). Nhờ đó tải được
  video ở các trang giấu URL bằng MSE. Dedupe theo URL tuyệt đối; đọc chunk đầu rồi `cancel`
  nên không tiêu thụ body của player; toàn bộ non-blocking, bọc `try/catch`.
- Message runtime `media/manifest`: background ghi thẳng `MediaItem` type `hls`/`dash` (bỏ qua
  đoán loại theo đuôi URL), sau đó dùng lại pipeline tải & ghép HLS sẵn có.

## [0.4.0] - 2026-07-12

Bản phát hành đầu tiên đầy đủ tính năng.

### Thêm

- **Phát hiện media** qua network (`webRequest` quan sát): HLS `.m3u8`, DASH `.mpd`,
  progressive (`.mp4/.webm/.m4v/.mov/.mkv/.ogg`...). Qua DOM (`<video>`/`<source>`) bằng
  content script. Phát hiện MSE/blob (player ẩn URL) bằng main-world hook.
- Dedupe + bổ sung thông tin (Content-Type/kích thước/Accept-Ranges); badge số lượng theo tab;
  reset theo điều hướng; xoá khi đóng tab.
- **Parse manifest** HLS/DASH: liệt kê chất lượng (độ phân giải/bitrate), nhớ chất lượng ưa thích.
- **Tải progressive** qua `chrome.downloads`, đặt tên file thông minh (tiêu đề + độ phân giải),
  làm sạch ký tự, theo dõi trạng thái, huỷ được.
- **Offscreen + ffmpeg.wasm** (single-thread, core đóng gói local, không CDN) để ghép HLS.
- **Tải & ghép HLS ra `.mp4`**: fetch segment song song (giới hạn luồng), giải mã **AES-128**
  (WebCrypto, IV chuẩn HLS), remux `-c copy`, tiến trình 2 pha, cảnh báo dung lượng lớn,
  hàng đợi tuần tự, huỷ giữa chừng.
- **Bypass non-DRM**: spoof `Referer`/`Origin` qua `declarativeNetRequest` session rules để vượt
  hotlink-protection/403; bỏ chặn UI (chuột phải/bôi chọn/kéo thả).
- **Trang cài đặt**: thư mục tải, ngưỡng cảnh báo dung lượng, số luồng fetch, lọc hiển thị theo loại,
  nút chẩn đoán ffmpeg.

### Ranh giới (không hỗ trợ)

- **KHÔNG** phá DRM/EME: Widevine/FairPlay/PlayReady và SAMPLE-AES qua EME — dừng và báo khi phát hiện.
- Chỉ dùng cho nội dung người dùng có quyền tải.

[Keep a Changelog]: https://keepachangelog.com/
[SemVer]: https://semver.org/lang/vi/
