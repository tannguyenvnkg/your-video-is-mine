# Hướng dẫn phát hành

> Chỉ hướng dẫn; bạn tự tạo tài khoản và nộp. Đóng gói bằng `pnpm zip` (ra `.output/*.zip`).

## Đóng gói

```bash
pnpm zip            # Chrome/Edge (MV3) -> .output/your_video_is_mine-<version>-chrome.zip
pnpm zip:firefox    # (nếu cần) bản Firefox
```

Trước khi nộp: kiểm bản build `Load unpacked` chạy đúng (xem `docs/TESTING.md`).

## Microsoft Edge Add-ons (Partner Center)

1. Đăng ký tài khoản nhà phát triển Edge tại Partner Center (miễn phí).
2. Tạo submission mới → tải file `.zip` (Chrome-MV3 dùng chung được cho Edge).
3. Điền: tên, mô tả, ảnh chụp (ít nhất 1), danh mục, ngôn ngữ.
4. **Giải trình quyền**: nêu rõ vì sao cần `webRequest`, `declarativeNetRequest`,
   `downloads`, `offscreen`, `<all_urls>` (phát hiện & tải video theo yêu cầu người dùng).
5. **Chính sách quyền riêng tư**: khai báo extension không thu thập dữ liệu cá nhân;
   mọi xử lý diễn ra cục bộ trên máy.
6. Nộp và chờ review.

## Chrome Web Store

1. Đăng ký tài khoản nhà phát triển (phí một lần ~5 USD).
2. Developer Dashboard → New item → tải `.zip`.
3. Điền store listing (mô tả, ảnh 1280×800, icon), phân loại.
4. **Privacy practices**: khai báo mục đích từng quyền + `host_permissions`; cam kết không bán dữ liệu.
5. Lưu ý Chrome siết extension “tải video” — mô tả rõ chỉ dùng cho nội dung người dùng có quyền,
   KHÔNG bypass DRM. Có thể bị review kỹ.
6. Nộp và chờ review.

## Lưu ý pháp lý khi phát hành

- Nêu rõ trong mô tả: chỉ tải nội dung bạn có quyền; KHÔNG hỗ trợ vượt DRM.
- Không dùng nhãn hiệu/logo của bên thứ ba trong store listing.
