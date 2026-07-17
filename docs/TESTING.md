# Ma trận kiểm thử — Your Video Is Mine

> Vì phần lõi (fetch/giải mã/ghép trong offscreen) chỉ chạy được trong trình duyệt thật,
> hãy load extension vào Edge/Chrome (`edge://extensions` → Developer mode → Load unpacked →
> `.output/chrome-mv3/`) rồi thử theo bảng dưới và điền kết quả.

---

## ⭐ Thử 5 site thật — bảng cần điền

**Vì sao cần bước này:** máy tự động đã kiểm được rất nhiều, nhưng nó chỉ chạy trên một stream video
"phòng thí nghiệm" do chính nó dựng ra. Chưa ai từng thử extension này trên **site thật** lấy một lần.
Chỉ có người ngồi bấm mới trả lời được. Đây là bước duy nhất máy không làm thay được.

**Chuẩn bị (làm 1 lần):**

1. Mở Terminal trong thư mục dự án, chạy: `pnpm build`
2. Mở Edge → gõ vào thanh địa chỉ: `edge://extensions`
3. Bật công tắc **Developer mode** (góc dưới bên trái).
4. Bấm **Load unpacked** → chọn thư mục `.output/chrome-mv3` trong dự án.
5. Extension xuất hiện. Ghim icon của nó ra thanh công cụ cho dễ bấm.

**Với MỖI site trong bảng, làm đúng 5 việc:**

1. Mở trang có video, **bấm play cho video chạy vài giây**.
2. Bấm **icon extension** → có hiện dòng video nào không? (cột *Hiện video?*)
3. Bấm nút **Chất lượng** → có hiện danh sách 720p/1080p… không? (cột *Ra chất lượng?*)
4. Chọn một chất lượng → bấm **Tải .mp4** → chờ xong. (cột *Tải xong?*)
5. **Mở file vừa tải bằng VLC** → xem có hình không, **và có TIẾNG không**. (cột *Có tiếng?*)
   👉 **Cột "Có tiếng?" là cột quan trọng nhất.** Đừng bỏ qua.

**Điền:** `✓` = được · `✗` = không được · `—` = không tới được bước đó.

| # | Loại site | Gợi ý site | Hiện video? | Ra chất lượng? | Tải xong? | **Có tiếng?** | Ghi chú (hiện lỗi gì) |
|---|---|---|---|---|---|---|---|
| 1 | HLS kiểu cũ (hình+tiếng chung) | trang demo HLS bất kỳ | | | | | |
| 2 | **HLS tách tiếng** | **Twitter/X** hoặc **Vimeo** | | | | | ⚠️ dự đoán: **CÂM** |
| 3 | DASH | trang demo DASH | | | — | — | dự đoán: không có nút tải |
| 4 | Progressive .mp4 | trang có video .mp4 thường | | — | | | |
| 5 | Site chống hotlink | site hay báo lỗi 403 | | | | | ⚠️ dự đoán: **lỗi 403** |

**Ba điều đã biết trước — nếu thấy đúng vậy thì KHÔNG phải bạn làm sai:**

- **Dòng 2 (Twitter/X, Vimeo) nhiều khả năng ra video CÂM.** Extension mới chỉ tải luồng hình, chưa
  biết ghép luồng tiếng. Đây là lỗi đã biết, đang xếp hàng sửa ở gói **W1.1**.
- **Dòng 3 (DASH) nhiều khả năng không có nút tải** — mới liệt kê được chất lượng thôi (gói **W1.5**).
- **Dòng 5 nhiều khả năng báo "Máy chủ trả mã 403"** ngay khi bấm **Chất lượng**. Máy đã chứng minh lỗi
  này có thật bằng thử nghiệm tự động (gói **W2.2**).

👉 **Việc cần bạn làm là XÁC NHẬN 3 dự đoán trên đúng hay sai trên site thật**, và cho biết có gì hỏng
ngoài dự đoán không. Nếu một dòng chạy tốt hơn dự đoán — **đó cũng là thông tin quý**, cứ ghi vào.

---

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
