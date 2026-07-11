# Changelog

Mọi thay đổi đáng chú ý được ghi ở đây. Định dạng theo [Keep a Changelog], phiên bản theo [SemVer].

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
