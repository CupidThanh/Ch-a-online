# Karaoke Tay Vịn Cún Cưng

Ứng dụng sân khấu karaoke tương tác cho TikTok LIVE. Giao diện livestream dọc 9:16, phong cách vui nhộn với chủ đề Corgi.

## Tính năng hiện có
- Kết nối phòng TikTok LIVE bằng username qua `tiktok-live-connector` (thư viện cộng đồng, không phải API chính thức).
- Nhận bình luận, lượt thích, quà tặng và cập nhật sân khấu qua WebSocket.
- Danh sách 5 bài hát; khán giả bình chọn bằng cách bình luận đúng số `1` đến `5`.
- Bảng xếp hạng điểm quà; Top 10 người có điểm quà cao nhất giữ 10 ghế VIP. Những người còn lại hiển thị ở khu vực khán giả.
- Cấu hình URL video karaoke, tên bài hát và ca sĩ từ bảng điều khiển.
- Có chế độ thử tương tác, khán giả mẫu và quà tặng mô phỏng.

## Chạy trên máy phát LIVE

Yêu cầu Node.js 20 trở lên.

```bash
cd live
npm install
npm start
```

Mở:
- Bảng điều khiển: `http://localhost:3000/live/control.html`
- Overlay 9:16: `http://localhost:3000/live/overlay.html`

Trong TikTok LIVE Studio, thêm nguồn Window Capture và chọn cửa sổ overlay. Với OBS, dùng Browser Source trỏ tới `http://localhost:3000/live/overlay.html`, kích thước 1080×1920.

## Thiết lập nội dung
1. Kết nối username TikTok LIVE trong bảng điều khiển.
2. Điền URL video MP4 có thể phát trực tiếp trong trình duyệt vào mục Video sân khấu.
3. Chọn từng vị trí 1–5 và nhập tên bài hát/ca sĩ.
4. Khán giả bình luận số 1–5 để bình chọn. Reset bình chọn khi bắt đầu vòng mới.

## Cách tính ghế VIP
Điểm được cộng theo số kim cương của quà tặng (số lượng nhân với giá trị kim cương). Top 10 người có tổng điểm cao nhất được hiển thị trên 10 ghế VIP. Các tài khoản còn lại nằm ở khu vực khán giả. Điểm chỉ tồn tại trong phiên chạy server hiện tại.

## Bảo mật và giới hạn
- Server mặc định chỉ lắng nghe `127.0.0.1`; không mở ra mạng công cộng nếu chưa bổ sung xác thực.
- Không yêu cầu mật khẩu, cookie hay session TikTok; chỉ đọc sự kiện phòng LIVE công khai.
- `tiktok-live-connector` là thư viện cộng đồng, có thể ngừng hoạt động khi TikTok thay đổi hệ thống.
- Chỉ sử dụng video, nhạc và hình ảnh mà bạn có quyền phát trên nền tảng livestream. Video URL phải cho phép trình duyệt phát/nhúng.
- Bản dựng giao diện hiện dùng emoji Corgi làm nhân vật tạm thời; bộ đồ họa Corgi 2D riêng có thể được thay thế trong giai đoạn tài nguyên hình ảnh.

## Giấy phép
MIT. Xem `LICENSE`.
