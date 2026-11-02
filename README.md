# VanhCodes Dino Remake

## 1. Tên sản phẩm
**VanhCodes Dino Remake**

## 2. Tác giả
**VanhCodes - Vanh Love IT**

## 3. Mô tả ngắn
**VanhCodes Dino Remake** là web game 2D thể loại chạy vô tận (Endless Runner) chạy trực tiếp trên trình duyệt, lấy cảm hứng từ Chrome Dino cổ điển. Toàn bộ hình ảnh pixel art monochrome và hiệu ứng âm thanh đều được tổng hợp bằng mã nguồn thuần (HTML5 Canvas 2D & Web Audio API), tích hợp chuỗi kết thúc đặc biệt (**Final Sequence & Final Scene**) mang phong cách hài hước.

## 4. Công nghệ sử dụng
- **HTML5**: Cấu trúc trang và phần tử `<canvas>`.
- **CSS3**: Bố cục responsive đa thiết bị, hỗ trợ `dvh`/`svh`, `safe-area-inset` và hiển thị sắc nét (`image-rendering: pixelated`).
- **JavaScript (ES Modules)**: Kiến trúc hướng module tách biệt hoàn toàn giữa simulation, rendering và audio.
- **HTML5 Canvas 2D**: Vẽ nhân vật Dino, chướng ngại vật, mây, mặt đất, HUD và hoạt ảnh Final Scene bằng hình khối lập trình.
- **Web Audio API**: Tổng hợp âm thanh thời gian thực (Jump, Land, Score, Collision, UI, Final Scene).
- **`localStorage`**: Lưu trữ điểm cao (`High Score`) cục bộ kèm cơ chế fallback an toàn khi trình duyệt chặn bộ nhớ.

## 5. Link Repository
- Repository URL: [github.com/vanhkazen/VanhCodes-Dino-Remake](https://github.com/vanhkazen/VanhCodes-Dino-Remake)

## 6. URL GitHub Pages
- Live Demo (GitHub Pages): [vanhkazen.github.io/VanhCodes-Dino-Remake/](https://vanhkazen.github.io/VanhCodes-Dino-Remake/)

## 7. Cấu trúc thư mục
```text
VanhCodes-Dino-Remake/
├── index.html
├── README.md
├── ARCHITECTURE.md
├── css/
│   └── style.css
└── js/
    ├── main.js
    ├── game.js
    ├── dinosaur.js
    ├── obstacles.js
    ├── renderer.js
    └── audio.js
