"""Estimate WebRTC streaming bandwidth for HDMI capture settings."""

from __future__ import annotations

from typing import Any


def estimate_bandwidth(
    width: int = 1280,
    height: int = 720,
    fps: int = 30,
    audio: bool = True,
) -> dict[str, Any]:
    pixels = width * height
    # Rough H.264/VP8 WebRTC bitrate model for capture content
    if pixels >= 1920 * 1080:
        video_mbps_low, video_mbps_high = 5.0, 8.0
    elif pixels >= 1280 * 720:
        video_mbps_low, video_mbps_high = 2.5, 4.0
    else:
        video_mbps_low, video_mbps_high = 1.0, 2.0

    # Scale lightly with fps deviation from 30
    scale = max(0.5, min(2.0, fps / 30.0))
    video_mbps_low *= scale
    video_mbps_high *= scale

    audio_kbps = 128.0 if audio else 0.0
    audio_mbps = audio_kbps / 1000.0

    total_low = video_mbps_low + audio_mbps
    total_high = video_mbps_high + audio_mbps

    audio_part = f" + 音频约 {int(audio_kbps)} kbps" if audio else "（无音频）"
    text = (
        f"{width}x{height}@{fps}fps 预计需要约 "
        f"{total_low:.1f}–{total_high:.1f} Mbps 网络带宽"
        f"（视频约 {video_mbps_low:.1f}–{video_mbps_high:.1f} Mbps{audio_part}）"
    )

    return {
        "width": width,
        "height": height,
        "fps": fps,
        "audio": audio,
        "video_mbps": {"low": round(video_mbps_low, 2), "high": round(video_mbps_high, 2)},
        "audio_kbps": audio_kbps,
        "total_mbps": {"low": round(total_low, 2), "high": round(total_high, 2)},
        "text": text,
    }
