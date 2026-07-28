# Android Board Dashboard

在 Ubuntu 工作站上运行的 Flask Dashboard，用于通过浏览器监测与控制 Android 开发板。

## 功能

- **可拖拽面板框架**：关闭、移动、缩放，允许面板重叠；工作区高度固定，面板可部分拖出但不可全部拖出；每个面板会记住最后一次的大小与位置（含关闭后再打开）
- **遥控器面板**：经 ADB `input keyevent` / 应用 deep link 发送按键
- **HDMI 输出监测**：经 MACROSILICON USB3 Video 采集，使用 WebRTC 推送到浏览器（一路采集、多浏览器订阅）
- **内存带宽面板**：经 ADB 读取 DDR monitor（含全表去重后的 `total` 汇总与各 client 曲线）；可用按钮开关各曲线图（默认显示 total / cpu / gpu / vpu）
- **Sf-HWC层面板**：经 ADB `dumpsys SurfaceFlinger --hwclayers` 按秒刷新，按表格顺序叠画图层（表前列在下、表后列在上；DEVICE 实线 / CLIENT 虚线，alpha 80%）
- **Sf-事件面板**：经 ADB `dumpsys SurfaceFlinger --events` 按秒采样 `mWorkDuration` / `mReadyDuration` / `last vsync time` 并绘制曲线
- 开始监测后按秒刷新实时网络带宽（WebRTC 收流统计）；未开播时显示预估
- 打开 HDMI 面板后自动开始播放
- 打开内存带宽面板后会自动启用 debugfs monitor 并按秒采样
- 打开 Sf-HWC层面板后自动按秒刷新
- 打开 Sf-事件面板后自动按秒刷新

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
| `WEBRTC_STUN_URLS` | WebRTC STUN（逗号分隔） | `stun:stun.l.google.com:19302` |
| `WEBRTC_TURN_URLS` | WebRTC TURN（可选，逗号分隔） | 空 |
| `WEBRTC_TURN_USERNAME` | TURN 用户名 | 空 |
| `WEBRTC_TURN_CREDENTIAL` | TURN 密码 | 空 |
| `WEBRTC_UDP_PORT_MIN` | ICE/RTP 本机 UDP 端口下限（含）；`0` 关闭限制 | `40000` |
| `WEBRTC_UDP_PORT_MAX` | ICE/RTP 本机 UDP 端口上限（含）；`0` 关闭限制 | `40199` |
| `WEBRTC_ANNOUNCE_IP` | 强制 ICE 宣告地址；**空则自动用浏览器请求的 Host**（如 `192.168.111.79`） | 空（自动） |
| `WEBRTC_ANNOUNCE_REPLACE` | 仅改写这些本机 IP（逗号分隔）；空=改写全部 host 候选 | 空 |

## 使用说明

1. 用 USB 连接 Android 开发板，执行 `adb devices` 确认已授权
2. 将开发板 HDMI 接到 MACROSILICON USB3 采集卡
3. 打开 Dashboard，顶栏查看 ADB / HDMI 状态
4. **遥控器**：点击按键即可发送
5. **HDMI**：打开面板后默认以 1920×1080 自动开始监测；可改分辨率或点「停止」后手动再开
6. **内存带宽**：打开面板后自动执行 `adb root`、挂载 debugfs、启用 DDR monitor，并每秒采样各 client 绘制曲线（默认显示 `cpu_a55_main` / `gpu` / `vpu`）
7. **Sf-HWC层**：打开面板后每秒读取 SurfaceFlinger HWC layers，按表格顺序叠画（最后一行在最上层）并在下方列出图例
8. **Sf-事件**：打开面板后每秒读取 SurfaceFlinger events，绘制 work / ready / last vsync 时序曲线

同一时间可多浏览器订阅同一路 HDMI 采集（一路采集、多路转发）。

## API 摘要

- `GET /api/status` — ADB / HDMI / 串口概览
- `POST /api/remote/key` — `{ "key": "DPAD_UP" }`
- `GET /api/hdmi/devices`
- `GET /api/hdmi/ice-servers` — 浏览器/服务端共用的 STUN/TURN 配置
- `GET /api/hdmi/bandwidth?width=1920&height=1080&fps=30&audio=1`
- `POST /api/ddr/enable` — 启用 DDR debugfs monitor
- `GET /api/ddr/sample?targets=cpu_a55_main,gpu,vpu,vdec_4k,vdec_2k_jpeg,emmc_sd,usb_pcie,phy_eth_dac` — 读取一次内存带宽
- `GET /api/hwc/layers` — 读取 SurfaceFlinger HWC 图层
- `GET /api/sf/events` — 读取 SurfaceFlinger events 时序字段
- `GET /api/serial/ports`

WebRTC 信令（Socket.IO）：`hdmi:offer` / `hdmi:answer` / `hdmi:ice` / `hdmi:stop`

## 项目结构

```text
app/
  routes/       # HTTP 页面与 REST API
  services/     # adb、capture、bandwidth、webrtc、ddr_bw、hwc_layers、sf_events
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
- **外网/DMZ 能开页面但无音视频**：原先服务端只宣告局域网 ICE 候选。现已默认启用 STUN；请重启 Dashboard，并用公网地址访问。若仍失败（对称 NAT），自建 TURN 并设置 `WEBRTC_TURN_*`。
- **跨网段能开页面但 WebRTC 为 closed**：信令走 TCP:5000，媒体走 UDP。默认将服务端 ICE UDP 限制在 `40000-40199`，请在中间防火墙放行到 Dashboard 主机的该 UDP 范围（可用 `WEBRTC_UDP_PORT_MIN/MAX` 调整）。Answer 后服务端会经 `hdmi:ice` trickle 候选。
- **经 DNAT/VIP 访问（例如浏览器打开 `192.168.111.79`，主机实为 `192.168.166.66`）**：默认会把 ICE 候选改写成请求 `Host`（无需再设 `WEBRTC_ANNOUNCE_IP`）。仍须保证网关上 **UDP 40000-40199** 与 TCP 5000 一样 DNAT 到实机。若 Host 不可靠，可显式设置 `WEBRTC_ANNOUNCE_IP`。
- 若 `Ctrl+C` 后终端不回显输入：执行 `stty sane`（或 `reset`）。新版本退出时会自动恢复。

## 后续扩展

- 串口终端面板（基于 `/dev/serial/by-id/...FTDI...`）
- HTTPS / 简易鉴权
- 多路并发 HDMI、截图与录像
