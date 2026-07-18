# Changelog

Mọi thay đổi đáng chú ý được ghi ở đây. Định dạng theo [Keep a Changelog], phiên bản theo [SemVer].

## [Chưa phát hành]

### Sửa lỗi — VIDEO TẢI VỀ NAY ĐÃ CÓ TIẾNG

**Video tải từ các site tách luồng tiếng (Twitter/X, Vimeo, Twitch, Mux, Cloudflare Stream…) trước
bản này bị CÂM** — tải xong, báo "Đã tải xong ✓", mở ra thì không có tiếng. Không lỗi, không cảnh báo.

- **Ghép luồng tiếng tách rời (`#EXT-X-MEDIA`)**: các site trên để hình và tiếng ở hai playlist riêng.
  Trước đây chỉ playlist hình được tải, tiếng bị vứt thẳng. Nay đọc `mediaGroups.AUDIO`, chọn đúng
  luồng tiếng của **chính mức chất lượng** bạn bấm (mỗi tier hình thường có một luồng tiếng riêng),
  tải cả hai rồi ghép bằng hai input + map tường minh.
- **Ước lượng dung lượng** nay tính cả segment tiếng (trước báo thiếu, thanh tiến trình chạy quá số).
- **Lỗi ffmpeg không còn bị nuốt**: mã trả về của `exec` trước đây bị vứt, nên khi ghép hỏng người
  dùng nhận thông báo vô nghĩa (`FS error`) ở sai chỗ, còn lý do thật bốc hơi. Nay báo đúng lý do
  kèm log ffmpeg.
- **Thiếu segment nay báo lỗi thay vì giao file hỏng**: trước đây một lỗ hổng trong danh sách segment
  bị `join('|')` render thành chuỗi rỗng và ffmpeg lặng lẽ cho ra file thiếu đoạn.

### Sửa lỗi — VIDEO fMP4/CMAF NAY TẢI ĐƯỢC (trước đây hỏng hẳn)

- **Hỗ trợ `EXT-X-BYTERANGE`**: nhiều site (kể cả stream mẫu chính thức của Apple) gói toàn bộ video
  vào **một file lớn**, mỗi "segment" chỉ là một đoạn byte trong đó. Trước đây phần đánh dấu đoạn bị
  bỏ qua, nên extension tải **nguyên file lớn một lần cho mỗi segment** — với video 10 phút của Apple
  là 27MB × 101 lần — rồi ghép ra byte rác và báo lỗi. Nay chỉ tải đúng đoạn cần (header `Range`).
  Video 10 phút này giờ tải xong trong ~26 giây, đủ hình và tiếng.
- Máy chủ phớt lờ yêu cầu tải theo đoạn (trả cả file thay vì đoạn) nay **báo lỗi rõ ràng** thay vì
  âm thầm ghi sai và ngốn băng thông.

### Sửa lỗi — VƯỢT "403 / TRANG CHẶN TẢI" ĐẦY ĐỦ HƠN

- **Bật vượt-chặn ngay từ bước đầu**: trên site chống hotlink (chặn tải bằng cách kiểm "bạn đến từ
  đâu"), trước đây bấm **Chất lượng** là báo *"Máy chủ trả mã 403"* — không bao giờ tới được nút tải,
  nên tính năng vượt chặn thành vô dụng đúng chỗ cần nó nhất. Nay extension gửi đúng thông tin "đến
  từ trang gốc" **ngay từ cú đọc manifest đầu tiên**, nên danh sách chất lượng hiện ra bình thường.
- **Vượt chặn cho cả các máy chủ phụ**: nhiều video để phần hình một máy chủ, các mảnh video và **khoá
  giải mã** ở máy chủ khác — mà khoá lại là thứ hay bị kiểm "đến từ đâu" nhất. Trước đây chỉ máy chủ
  chính được vượt chặn, nên tải tới giữa chừng là kẹt *"Tải mảnh lỗi… 403"*. Nay extension đọc trước
  danh sách mảnh, rồi bật vượt-chặn cho **mọi máy chủ** liên quan trước khi tải.
- **Dọn sạch dấu vết vượt-chặn** khi tải xong/lỗi/huỷ (trước chỉ dọn khi tải xong), tránh ảnh hưởng
  các trang khác bạn duyệt trong cùng phiên.
- **Không còn đụng tới việc duyệt web bình thường của bạn**: cơ chế vượt-chặn trước đây có thể ghi
  đè thông tin "đến từ đâu" lên **chính traffic của trang** (trình phát, khung nhúng) khi bạn đang
  tải từ domain đó — hệ quả xấu nhất là player của trang hỏng, hoặc bạn bị đăng xuất. Nay nó chỉ áp
  cho **đúng các yêu cầu do extension phát ra**, tuyệt đối không chạm vào yêu cầu của trang.
- **Tải hai video cùng lúc từ cùng một máy chủ không còn phá nhau**: trước đây hai lượt tải trên cùng
  một máy chủ dùng chung một "dấu", cái xong trước gỡ mất dấu của cái đang chạy khiến nó kẹt giữa
  chừng. Nay mỗi lượt tải có dấu riêng.
- **Tự dọn dấu vết còn sót**: nếu một lượt tải chết bất thường, dấu vết vượt-chặn còn lại sẽ được
  đối soát và xoá khi mở lại trình duyệt (và mỗi lần dịch vụ nền khởi động lại).
- **Tải file .mp4 trực tiếp nay cũng vượt được 403**: trước đây nút **Tải xuống** cho video .mp4 nhờ
  trình duyệt tự tải — nhưng cú tải đó **không mang được thông tin "đến từ đâu"**, nên trên site chống
  hotlink nó dính 403 và **không tải được** (đã đo tận nơi). Nay extension tự tải phần dữ liệu (mang
  đúng thông tin vượt-chặn) rồi mới giao file cho trình duyệt lưu — nên .mp4 trên các site này tải
  được như HLS. Kèm theo: báo tiến trình theo dung lượng, tự dừng với thông báo rõ nếu máy chủ treo
  quá lâu, và chặn file quá lớn (trên ~2GB) bằng thông báo thay vì làm treo âm thầm.

### Sửa lỗi — KHÔNG CÒN "QUAY MÃI KHÔNG BIẾT ĐANG CHỜ GÌ"

- **Mất mạng giữa chừng nay BÁO LỖI, không treo vĩnh viễn.** Trước bản này, nếu máy chủ nhận yêu
  cầu rồi im lặng (rớt mạng, CDN treo, wifi chập chờn), việc tải **đứng im mãi mãi** — không lỗi,
  không thông báo, bấm Huỷ cũng không ăn thua, và **mọi video xếp hàng phía sau chết theo**. Nay
  extension tự phát hiện và báo lỗi trong khoảng một phút (đo thật: 63,7 giây).
- **Bấm Huỷ nay dừng NGAY.** Trước đây nút Huỷ chỉ được đọc *giữa* hai bước, nên khi đang chờ mạng
  thì bấm không có tác dụng gì: popup báo "đã huỷ" trong khi máy vẫn âm thầm tải tiếp. Nay lệnh huỷ
  ngắt thẳng kết nối đang chạy.
- **Không "cắt oan" mạng chậm.** Đồng hồ đếm theo *sự im lặng* chứ không theo tổng thời gian: video
  nặng tải 5 phút trên mạng yếu vẫn chạy bình thường, chỉ khi thực sự **đứng im** mới bị ngắt.
- **Thôi thử lại vô ích.** Link hết hạn hoặc bị chặn hẳn (403/404…) trước đây bị thử lại 4 lần liên
  tiếp trong tích tắc — vừa vô nghĩa vừa dễ khiến máy chủ coi là tấn công rồi chặn IP. Nay dừng
  ngay lần đầu, còn lỗi tạm thời thì thử lại có giãn cách tăng dần.

### Cải thiện — MỖI VIDEO CHỈ CÒN MỘT DÒNG TRONG DANH SÁCH

- **Ẩn playlist con**: một video HLS tách tiếng trước đây hiện lên **ba dòng "HLS" giống nhau**
  (bản gốc + luồng hình + luồng tiếng), vì trình phát tải cả ba và extension thấy hết. Bấm nhầm
  dòng con cho ra "video" chỉ có tiếng hoặc chỉ có hình. Nay extension đọc bản gốc, nhận ra hai
  dòng kia là thành phần con của nó và **ẩn đi** — bạn chỉ thấy một dòng, chọn chất lượng như cũ.

## [0.6.1] - 2026-07-17

### Sửa lỗi — TẢI HLS NAY MỚI THỰC SỰ CHẠY

**Tải HLS (.m3u8) trước bản này CHƯA TỪNG hoạt động** — kể từ commit đầu tiên. Bấm "Tải .mp4" thì
job đứng im ở "Đang nạp bộ xử lý video…" **vĩnh viễn, không báo lỗi**. Ba lỗi độc lập chồng lên nhau,
cả ba đều im lặng tuyệt đối:

- **ffmpeg không nạp được**: bản `@ffmpeg/core` đóng gói là **UMD**, trong khi `@ffmpeg/ffmpeg` luôn
  tạo worker `type:"module"` nên nạp core bằng `import()` và cần `export default` (chỉ bản **ESM** có).
  Sinh ra `Lỗi: Error: failed to import ffmpeg-core.js`. Đã chuyển sang `dist/esm` + khoá bằng unit test.
- **Offscreen không có `chrome.storage`**: offscreen document chỉ được cấp `chrome.runtime`. Mọi lời gọi
  ghi tiến trình (`updateHlsJob`) ném `TypeError` ngay lập tức; khối `catch` lại ghi lỗi bằng đúng hàm
  đó nên **ném tiếp**, và lỗi bị `.catch(() => undefined)` nuốt sạch → job kẹt mãi mãi. Nay offscreen
  báo tiến trình qua message `hls/progress` để background ghi hộ; `concurrency` do background truyền vào.
- **Race khi ghi segment song song**: chỉ số ghi được tăng *sau* `await`, nên hai luồng ghi trùng một
  buffer — mà `writeFile` của ffmpeg **transfer (detach)** ArrayBuffer → `"ArrayBuffer is detached"`
  ở khoảng segment thứ 10. Nay xí phần chỉ số trước khi `await`.

Đã kiểm chứng thật: tải trọn 184 segment và ghép ra `.mp4` trong ~75 giây.

### Sửa lỗi — hết "hỏng mà không nói"

- Message gửi sang bộ xử lý video nếu rớt thì **báo lỗi ra popup** thay vì im lặng treo.
- Tải playlist có **timeout 30s** + kiểm mã HTTP (trước đây treo là treo vĩnh viễn, và trang lỗi
  403/404 bị hiểu nhầm thành "playlist không có segment").
- `ensureOffscreen` chỉ còn bỏ qua đúng lỗi "document đã tồn tại"; lỗi thật sẽ hiện ra.
- Lỗi nạp ffmpeg lúc khởi động không còn bị nuốt — ghi ra console của offscreen.
- Hết chuỗi lặp xấu `Lỗi: Error: ...` (ffmpeg reject bằng chuỗi, không phải `Error`).

### Thay đổi

- Trạng thái mới **"Đang chờ bộ xử lý nhận việc…"** tách khỏi "Đang nạp bộ xử lý video…", để phân biệt
  "chưa nhận việc" với "đang tải playlist". Nhãn cũ nói sai việc đang chạy.

### Nội bộ

- **`pnpm e2e`**: cổng kiểm thử tự động nạp bản build vào Edge thật, chạy "Kiểm tra ffmpeg" và tải trọn
  một video HLS. Toàn bộ compile/lint/test/build đều XANH suốt thời gian tính năng chủ lực đã chết —
  không cổng tĩnh nào bắt được lớp lỗi này.
- Ghi chú phát hành trên GitHub nay lấy đúng mục CHANGELOG của phiên bản thay vì danh sách commit thô.

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
