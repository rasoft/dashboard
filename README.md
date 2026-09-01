# Android Board Dashboard

在 Ubuntu 工作站上运行的 Flask Dashboard，用于通过浏览器监测与控制 Android 开发板。

## 功能

- **可拖拽面板框架**：关闭、移动、缩放，允许面板重叠；工作区高度固定，面板可部分拖出但不可全部拖出；每个面板会记住最后一次的大小与位置（含关闭后再打开）
- **遥控器面板**：点击虚拟按键经 ADB 发送（默认关闭）
- **输入面板**：文本框经 ADB `input text` 发送字符串到设备（默认关闭）
- **操作台面板**：经 MACROSILICON USB3 Video 采集，WebRTC 推送到浏览器（一路采集、多浏览器订阅）；打开后可用键盘发送方向键 / 确认 / 返回 / 音量到 ADB；可对当前画面做最长 30 秒的延时录制
- **录制回放面板**：回放操作台刚录下的最近 30 秒 HDMI 画面（超出部分丢弃）；支持播放 / 暂停 / 上一帧 / 下一帧，可拖动进度条按时间快速定位，并可保存为 MP4 到本地（默认关闭）
- **内存带宽 - 吞吐量面板**：经 ADB 读取 DDR monitor（含全表去重后的 `total` 汇总与各 client 曲线）；可用按钮开关各曲线图（默认显示 total / cpu / gpu / vpu）
- **内存带宽 - 效率面板**：同源 `status_raw`；曲线为 `RD BW / RD Trans`、`WR BW / WR Trans`（Trans 为 0 时记 0；单位 B/trans）；布局同吞吐量面板（默认关闭）
- **SurfaceFlinger - hwclayers 面板**：经 ADB `dumpsys SurfaceFlinger --hwclayers` 按秒刷新；用层 frame 以爆炸轴测图展示（绕 Z 共逆时针 270°；按表格顺序向上拉开；DEVICE 实线 / CLIENT 虚线），并在下方列出图例
- **IComposer - VPU 面板**：经 ADB `dumpsys android.hardware.graphics.composer3.IComposer/default` 读取 NationalChip HWC 表；用 **VPU View (x y w h)**（第 3/4 列为宽高）以爆炸轴测图叠画各层位置，并按 Z 从大到小列出明细
- **SurfaceFlinger - events 面板**：经 ADB `dumpsys SurfaceFlinger --events` 按秒采样 `mWorkDuration` / `mReadyDuration` / `last vsync time` 并绘制曲线
- **SurfaceFlinger - frametimeline 面板**：经 ADB `dumpsys SurfaceFlinger --frametimeline -all`；打开面板后自动按秒刷新；纵轴帧序号、横轴 0–⌈末帧 Expected Present⌉₀₀ ms，绘制 Expected/Actual 的 Start→Present 区间（Jank 红色），点选查看 Layer 明细
- **proc - meminfo 面板**：经 ADB 读取 `/proc/meminfo`，按秒采样；层叠曲线展示 Swap 已用 / Cached+Buffers / AnonPages，并叠加 MemUsed 曲线（默认关闭）
- **proc - diskstats 面板**：经 ADB 读取 `/proc/diskstats`；打开时用 `df` 自动映射 `/` `/metadata` `/system_ext` `/vendor` `/product` `/cache` `/data` 到块设备，并与 mmcblk0 / zram0 一起分图绘制读写吞吐（布局同内存带宽；默认关闭）
- 开始监测后按秒刷新实时网络带宽（WebRTC 收流统计）；未开播时显示预估
- 打开操作台面板后自动开始播放，并启用键盘 ADB 按键发送
- 操作台在采集中可点「延时录制」：环形缓冲最近 30 秒，停止后自动打开录制回放面板
- 顶栏「暂停 / 继续」可冻结各面板数据刷新与操作台 WebRTC 播放；继续时丢弃暂停期间积压的视频帧
- 遥控器面板默认不打开
- 输入面板默认不打开
- 打开内存带宽 - 吞吐量 / 效率面板后会自动启用 debugfs monitor 并按秒采样；设备重启 / adb 重连后若 status_raw 不可读，会自动重新 `adb root` + mount debugfs + enable
- 打开 SurfaceFlinger - hwclayers 面板后自动按秒刷新
- 打开 IComposer - VPU 面板后自动按秒刷新
- 打开 SurfaceFlinger - events 面板后自动按秒刷新
- 打开 SurfaceFlinger - frametimeline 面板后自动开始采样
- 打开 proc - meminfo 面板后按秒采样 `/proc/meminfo`
- 打开 proc - diskstats 面板后先经 `df` 解析挂载磁盘，再按秒采样 `/proc/diskstats` 绘制吞吐曲线

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
4. **操作台**：打开面板后默认以 1920×1080 自动开始监测；可用键盘发送方向键 / 确认 / 返回 / 音量到设备；可改分辨率或点「停止」后手动再开；采集中可点「延时录制」保留最近 30 秒画面（更早的内容会被丢弃）
5. **录制回放**：默认关闭；停止录制后会自动打开。可播放 / 暂停，按「上一帧」「下一帧」逐帧查看，或拖动进度条按时间快速定位；点「保存视频」将 MP4 存到本机文件夹
6. **遥控器**：默认关闭；打开后点击虚拟按键发送
7. **输入**：默认关闭；打开后面板内输入文本，点「发送」或按 Enter，经 `adb shell input text` 发到设备
8. **内存带宽 - 吞吐量**：打开面板后自动执行 `adb root`、挂载 debugfs、启用 DDR monitor，并每秒采样各 client 绘制曲线（默认显示 `cpu_a55_main` / `gpu` / `vpu`）
9. **内存带宽 - 效率**：默认关闭；同源 DDR monitor，绘制各 client 的 `RD BW/RD Trans` 与 `WR BW/WR Trans`（B/trans）
10. **SurfaceFlinger - hwclayers**：打开面板后每秒读取 SurfaceFlinger HWC layers，按表格顺序向上拉开绘制爆炸轴测图（CLIENT 虚线），并在下方列出图例
11. **IComposer - VPU**：打开面板后每秒读取 composer dumpsys 中的 NationalChip HWC 表；用 VPU View (x y w h) 爆炸轴测图展示屏幕位置，并按 Z 从大到小列出各层
12. **SurfaceFlinger - events**：打开面板后每秒读取 SurfaceFlinger events，绘制 work / ready / last vsync 时序曲线
13. **SurfaceFlinger - frametimeline**：打开面板后自动按秒刷新；纵轴帧序号、横轴 0–⌈末帧 Expected Present⌉₀₀ ms，并排绘制 Expected/Actual 的 Start→Present；点击某一帧查看 Layer 明细
14. **proc - meminfo**：默认关闭；打开后按秒读取 `/proc/meminfo`，层叠绘制 Swap 已用 / Cached+Buffers / AnonPages，并叠加 MemUsed 曲线
15. **proc - diskstats**：默认关闭；打开后经 `df` 映射挂载点到块设备，分图绘制 mmcblk0 / zram0 与各挂载分区的 RD / WR / Total（MB/s）；默认打开 mmcblk0、zram0、`/`、`/data`

同一时间可多浏览器订阅同一路 HDMI 采集（一路采集、多路转发）。

## API 摘要

- `GET /api/status` — ADB / HDMI / 串口概览
- `POST /api/remote/key` — `{ "key": "DPAD_UP" }`
- `POST /api/remote/text` — `{ "text": "hello" }`（经 `adb shell input text`）
- `GET /api/hdmi/devices`
- `GET /api/hdmi/ice-servers` — 浏览器/服务端共用的 STUN/TURN 配置
- `GET /api/hdmi/bandwidth?width=1920&height=1080&fps=30&audio=1`
- `POST /api/hdmi/delay-export` — 将延时录制的 JPEG 帧序列编码为 MP4
- `POST /api/ddr/enable` — 启用 DDR debugfs monitor
- `GET /api/ddr/sample?targets=cpu_a55_main,gpu,vpu,vdec_4k,vdec_2k_jpeg,emmc_sd,usb_pcie,phy_eth_dac` — 读取一次内存带宽（含 `rd_trans` / `wr_trans`，供吞吐量与效率面板共用）
- `GET /api/hwc/layers` — 读取 SurfaceFlinger HWC 图层
- `GET /api/hwc/status` — 读取 NationalChip HWC 状态表（composer dumpsys）
- `GET /api/sf/events` — 读取 SurfaceFlinger events 时序字段
- `GET /api/sf/frametimeline` — 读取 SurfaceFlinger FrameTimeline（`--frametimeline -all`）
- `GET /api/proc/meminfo` — 读取 `/proc/meminfo`（层叠：Swap 已用 / Cached+Buffers / AnonPages；另含 MemUsed）
- `GET /api/proc/diskstats/map` — 经 `df` 解析挂载点 → 块设备（mmcblk0 / zram0 + 目标挂载）
- `GET /api/proc/diskstats?devices=mmcblk0,zram0,dm-5` — 读取 `/proc/diskstats` 累计扇区计数
- `GET /api/serial/ports`

WebRTC 信令（Socket.IO）：`hdmi:offer` / `hdmi:answer` / `hdmi:ice` / `hdmi:stop`

## 项目结构

```text
app/
  routes/       # HTTP 页面与 REST API
  services/     # adb、capture、bandwidth、webrtc、ddr_bw、hwc_layers、hwc_status、sf_events、sf_frametimeline、meminfo、diskstats、delay_export
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
- 多路并发 HDMI、截图与导出录像
