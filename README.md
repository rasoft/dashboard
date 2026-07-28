# Android Board Dashboard

在 Ubuntu 工作站上运行的 Flask Dashboard，用于通过浏览器监测与控制 Android 开发板。

## 功能

- **可拖拽面板框架**：折叠、关闭、移动、缩放；布局保存在浏览器 `localStorage`
- **遥控器面板**：经 ADB `input keyevent` / 应用 deep link 发送按键
- **HDMI 输出监测**：经 MACROSILICON USB3 Video 采集，使用 WebRTC 推送到浏览器
- 开始监测前显示估算网络带宽（720p / 1080p）

串口（FTDI）设备发现接口已预留：`GET /api/serial/ports`，终端面板未在首期实现。

## 系统依赖

```bash
sudo apt update
sudo apt install -y python3-pip python3-venv python3-dev \
  v4l-utils alsa-utils libavdevice-dev libavformat-dev libavcodec-dev \
  libavutil-dev libswscale-dev pkg-config
```

本机需已安装 `adb`、`ffmpeg`。用户需有权访问视频/音频设备，例如：

```bash
sudo usermod -aG video,audio $USER
# 重新登录后生效
```

确认采集卡：

```bash
v4l2-ctl --list-devices
arecord -l
ls -l /dev/serial/by-id/   # 可选：查看 FTDI 串口
```

## 安装与运行

```bash
cd /home/alan/dashboard
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

默认监听 `0.0.0.0:5000`。在其他电脑浏览器打开：

```text
http://<工作站IP>:5000
```

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DASHBOARD_HOST` | 绑定地址 | `0.0.0.0` |
| `DASHBOARD_PORT` | 端口 | `5000` |
| `ADB_PATH` | adb 可执行文件 | `adb` |
| `ADB_SERIAL` | 指定设备序列号 | 空（取第一台 online 设备） |
| `SECRET_KEY` | Flask/SocketIO secret | 开发默认值 |

## 使用说明

1. 用 USB 连接 Android 开发板，执行 `adb devices` 确认已授权
2. 将开发板 HDMI 接到 MACROSILICON USB3 采集卡
3. 打开 Dashboard，顶栏查看 ADB / HDMI 状态
4. **遥控器**：点击按键即可发送
5. **HDMI**：选择分辨率、是否开启音频，查看带宽提示后点「开始监测」

同一时间只允许一路 HDMI WebRTC 会话。

## API 摘要

- `GET /api/status` — ADB / HDMI / 串口概览
- `POST /api/remote/key` — `{ "key": "DPAD_UP" }`
- `GET /api/hdmi/devices`
- `GET /api/hdmi/bandwidth?width=1280&height=720&fps=30&audio=1`
- `GET /api/serial/ports`

WebRTC 信令（Socket.IO）：`hdmi:offer` / `hdmi:answer` / `hdmi:ice` / `hdmi:stop`

## 项目结构

```text
app/
  routes/       # HTTP 页面与 REST API
  services/     # adb、capture、bandwidth、webrtc
  signaling.py  # Socket.IO 信令
static/         # CSS / JS
templates/      # 单页 Dashboard
run.py
```

## 故障排查（HDMI / WebRTC）

- 采集依赖本机 `ffmpeg`（经 V4L2 MJPEG 管道），不是 OpenCV 直采。
- 若提示 `Device or resource busy`：确认没有其他进程占用 `/dev/video0`，然后重启 Dashboard。
- 画面全黑但连接成功：检查开发板 HDMI 是否已接到采集卡、输入源是否有信号。
- 面板状态会显示 ICE / PeerConnection 状态；信令需先连通再发 Offer。


- 串口终端面板（基于 `/dev/serial/by-id/...FTDI...`）
- HTTPS / 简易鉴权
- 多路并发 HDMI、截图与录像
