# libav.js variant `ts2mp4d` — build provenance

Bản wasm trong thư mục này **tự dựng từ mã nguồn**, không lấy từ npm. Đây là bộ ghép
(muxer) duy nhất của extension — nó thay `@ffmpeg/core`.

## Vì sao tự dựng, không dùng bản npm dựng sẵn

Đã ĐO (2026-07-19): **cả 15 variant dựng sẵn của libav.js trên npm đều KHÔNG đọc được
MPEG-TS** — chạy thử từng bản với file H.264/AAC thật, tất cả trả
`[avformat_open_input_js] Invalid data found when processing input`. Mà `.ts` chính là
định dạng HLS ngoài đời dùng chủ yếu, và HLS là ưu tiên số 1 của dự án.
Bản `webcodecs` đọc được fMP4/CMAF nhưng không đọc được `.ts`.

⚠️ **Đừng "đơn giản hoá" bằng cách quay lại `npm i libav.js` rồi dùng variant dựng sẵn.**
Nó sẽ chết ở đúng định dạng quan trọng nhất. Đây là kết luận đo bằng máy, không phải suy đoán.

## Vì sao KHÔNG dùng @ffmpeg/core nữa

`@ffmpeg/core` được dựng với `--enable-gpl --enable-libx264 --enable-libx265` → **GPL-2.0-or-later**,
trong khi dự án dán nhãn **MIT**. Nó chiếm 98,45% dung lượng bản build (32,2MB / 32,8MB) và
extension **chưa bao giờ gọi tới** bộ mã hoá GPL đó — ta chỉ chạy stream copy.
Bản `ts2mp4d` này có `CONFIG_GPL=0`, **không encoder nào**, và là LGPL-2.1.

## Config chính xác

```
node ./mkconfig.js ts2mp4d '["avformat","avcodec","avbsf","demuxer-mpegts","format-mp4",
 "parser-h264","parser-aac","decoder-aac","bsf-extract_extradata","bsf-aac_adtstoasc",
 "bsf-h264_mp4toannexb"]'
```

Hai điểm KHÔNG hiển nhiên, đã trả giá khi dựng — đừng bỏ:

- **`decoder-aac` là BẮT BUỘC**, dù ta chỉ stream-copy chứ không giải mã. Thiếu nó,
  `avformat_find_stream_info` không xác định nổi tham số audio (`sample_rate=0 channels=0`)
  kể cả khi tăng `analyzeduration`/`probesize`; bộ ghép mp4 sau đó chết bằng
  `sample rate not set` → `RuntimeError: divide by zero`. Đo rồi mới biết.
  (Đây là *decoder*, không phải *encoder* — không ảnh hưởng license.)
- **Fragment `avbsf` là BẮT BUỘC.** `--enable-bsf=aac_adtstoasc` chỉ biên dịch bộ lọc vào
  libavcodec; **không** export một hàm `av_bsf_*` nào sang JS nếu thiếu `avbsf`
  (`-DLIBAVJS_WITH_BSF=1`). Triệu chứng: link xong nhưng gọi hàm thì `undefined`.

## Toolchain

- **emsdk 6.0.3** (`./emsdk install latest && ./emsdk activate latest`). Không cần Docker
  (`Dockerfile.development` của upstream không còn được bảo trì).
- Mã nguồn ffmpeg **nằm sẵn trong tarball npm của libav.js** (`package/sources/ffmpeg-8.1.tar.xz`)
  — không phải tải thêm gì.
- Thời gian dựng sạch: **~79 giây** (`-j8`, Apple silicon).

### 🔴 Bẫy macOS — thiếu cái này là link hỏng mà không hiểu vì sao

`mk/ffmpeg.mk` của libav.js truyền `--cc=emcc --cxx=em++ --ranlib=emranlib` nhưng **quên
`--ar=emar`**. Trên macOS, `config.mak` do đó lấy `ar` của Apple, thứ này tạo ra **archive
rỗng 96 byte** kèm cảnh báo `ranlib: warning: archive member ... not a mach-o file`, rồi
lỗi chỉ lộ ra tận lúc link dưới dạng ~40 dòng `wasm-ld: symbol exported via --export not found`.

Cách chữa: chèn một shim `ar` → `emar` vào đầu `PATH` (xem `scripts/build-libav.mjs`).
Dựng trên Linux/CI thì không dính.

## Dựng lại

```
pnpm build:libav       # xem scripts/build-libav.mjs
```

Script sẽ kiểm tra emsdk, dựng variant, rồi copy kết quả vào `vendor/libav/`.
Sau đó `scripts/copy-libav.test.ts` khoá lại các bất biến (tên variant, có `export default`,
không encoder, có văn bản LGPL).

## Nghĩa vụ LGPL-2.1

Ta phát hành **binary** dựng từ mã nguồn LGPL, nên phải:

1. **Kèm văn bản giấy phép** — `vendor/libav/LICENSE.txt` (đã có, và được copy vào bản build).
2. **Cung cấp mã nguồn tương ứng** — ffmpeg 8.1 + libav.js 6.9.8 + file config ở trên.
   Cả hai đều là mã nguồn công khai, không sửa đổi; `config.json` của variant nằm trong repo này.
3. **Cho phép relink** — wasm là file rời, nạp qua URL, không nội tuyến vào bundle, nên
   người dùng thay được bản libav khác. Ràng buộc này là lý do **đừng bao giờ inline wasm
   vào JS bundle**.

Khác hẳn `@ffmpeg/core` (GPL): ở đó ta sẽ phải công bố mã nguồn tương ứng của một binary
mà **không ai xác định nổi nó dựng từ commit nào** — package npm của nó không ghi `gitHead`,
không ghi provenance gì cả.
