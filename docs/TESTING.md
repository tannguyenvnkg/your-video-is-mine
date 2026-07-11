# Ma trận kiểm thử — Your Video Is Mine

> Vì phần lõi (fetch/giải mã/ghép trong offscreen) chỉ chạy được trong trình duyệt thật,
> hãy load extension vào Edge/Chrome (`edge://extensions` → Developer mode → Load unpacked →
> `.output/chrome-mv3/`) rồi thử theo bảng dưới và điền kết quả.

## Cách chạy nhanh

1. `pnpm build` → load `.output/chrome-mv3/`.
2. Mở trang test, phát video, bấm icon extension.
3. Với HLS/DASH: bấm **Chất lượng** để liệt kê; với progressive: bấm **Tải xuống**;
   với HLS: chọn variant rồi **Tải .mp4**.
4. Kiểm file tải về mở/phát được trọn vẹn (hình + tiếng).
5. Chẩn đoán ffmpeg: mở trang **Cài đặt** → **Kiểm tra ffmpeg** (phải báo “✓ ffmpeg chạy tốt”).

## Ma trận

| Loại | Nguồn thử | Phát hiện | Liệt kê chất lượng | Tải về | Phát được | Ghi chú |
|---|---|---|---|---|---|---|
| Progressive .mp4 | trang có `<video src=.mp4>` |  |  n/a |  |  |  |
| Progressive .webm | trang .webm |  | n/a |  |  |  |
| HLS TS (không mã hoá) | stream demo HLS.js |  |  |  |  |  |
| HLS fMP4 (CMAF) | stream CMAF |  |  |  |  | init + m4s |
| HLS AES-128 | stream có `#EXT-X-KEY:METHOD=AES-128` |  |  |  |  | giải mã WebCrypto |
| DASH .mpd | stream DASH demo |  |  | ✗ (v0.4: chưa mux DASH) | — | chỉ liệt kê |
| DRM/EME | Netflix/OTT bản quyền | — | — | **DỪNG** | — | phải báo “không hỗ trợ” |
| MSE/blob | player tự chế (blob:) | (báo hiệu) | — | ✗ (thử nghiệm) | — | chỉ phát hiện |

Điền: ✓ đạt / ✗ lỗi / — không áp dụng.

## Giới hạn đã biết (v0.4.0)

- **DRM/EME**: không hỗ trợ và sẽ dừng (Widevine/FairPlay/PlayReady, SAMPLE-AES qua EME).
- **YouTube**: dùng format googlevideo riêng (range request, không phải HLS chuẩn) → ngoài phạm vi.
- **DASH**: mới liệt kê chất lượng; tải & ghép DASH segmented chưa hỗ trợ (representation là file .mp4
  trực tiếp thì có thể tải như progressive).
- **HLS `#EXT-X-BYTERANGE`**: chưa xử lý byte-range (sẽ tải nguyên file cho mỗi đoạn).
- **HLS đổi init segment giữa chừng** (fMP4 + discontinuity): chỉ dùng init đầu tiên.
- **HLS trộn method mã hoá** giữa chừng: nếu gặp method khác AES-128 sau đó, job dừng với lỗi.
- **Bộ nhớ**: HLS được nối/ghép trong RAM (MEMFS của ffmpeg) → file rất lớn có thể cạn RAM;
  có cảnh báo trước theo ngưỡng ở trang Cài đặt.
- **Spoof Referer/Origin**: dùng `declarativeNetRequest` session rule theo host; chỉ ở mức
  KHÔNG-DRM để vượt hotlink/403.

## Ghi lại kết quả

Ghi ngày, phiên bản Edge/Chrome, và bất kỳ lỗi nào (kèm log `edge://extensions` → Errors,
console của offscreen/background) vào cuối file này khi test.
