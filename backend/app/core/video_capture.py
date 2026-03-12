import threading

import cv2

RTSP_SCHEMES = ("rtsp://", "rtsps://")
_CAPTURE_OPEN_LOCK = threading.Lock()
_NVDEC_CONFIG_LOGGED = False

RTSP_TRANSPORT = "tcp"
RTSP_BUFFER_SIZE = 8
RTSP_OPEN_TIMEOUT_MS = 5000
RTSP_READ_TIMEOUT_MS = 5000
RTSP_ENABLE_NVDEC = False
RTSP_NVDEC_CODEC = ""
RTSP_HW_DEVICE = -1
RTSP_FFMPEG_CAPTURE_OPTIONS: list[tuple[str, str]] = []


def is_rtsp_source(source_path: str) -> bool:
    return source_path.strip().lower().startswith(RTSP_SCHEMES)


def _parse_ffmpeg_capture_options(raw: str | None) -> list[tuple[str, str]]:
    if not raw:
        return []

    options: list[tuple[str, str]] = []
    for chunk in raw.split("|"):
        entry = chunk.strip()
        if not entry or ";" not in entry:
            continue
        key, value = entry.split(";", 1)
        key = key.strip()
        value = value.strip()
        if key and value:
            options.append((key, value))
    return options


def _merge_ffmpeg_capture_options(
    preferred: list[tuple[str, str]],
    defaults: list[tuple[str, str]],
) -> list[tuple[str, str]]:
    merged: list[tuple[str, str]] = []
    seen: set[str] = set()

    for key, value in preferred + defaults:
        normalized = key.strip().lower()
        if not normalized or normalized in seen:
            continue
        merged.append((key, value))
        seen.add(normalized)

    return merged


def _serialize_ffmpeg_capture_options(options: list[tuple[str, str]]) -> str:
    return "|".join(f"{key};{value}" for key, value in options)


def _build_rtsp_ffmpeg_capture_options(*, enable_hwaccel: bool | None = None) -> str:
    transport = RTSP_TRANSPORT.lower()
    enable_nvdec = RTSP_ENABLE_NVDEC if enable_hwaccel is None else enable_hwaccel

    defaults: list[tuple[str, str]] = []
    if transport and transport != "auto":
        defaults.append(("rtsp_transport", transport))
        if transport == "tcp":
            defaults.append(("rtsp_flags", "prefer_tcp"))
    if enable_nvdec:
        # FFmpeg CUDA decode path (NVDEC). Keep codec selection optional.
        defaults.append(("hwaccel", "cuda"))
        defaults.append(("hwaccel_output_format", "cuda"))
        nvdec_codec = RTSP_NVDEC_CODEC
        if nvdec_codec and nvdec_codec.lower() != "auto":
            defaults.append(("video_codec", nvdec_codec))

    preferred = list(RTSP_FFMPEG_CAPTURE_OPTIONS)
    merged = _merge_ffmpeg_capture_options(preferred, defaults)
    return _serialize_ffmpeg_capture_options(merged)


def _build_capture_open_params(
    *,
    is_rtsp: bool,
    enable_hwaccel: bool | None = None,
) -> list[int]:
    if not is_rtsp:
        return []

    params: list[int] = []
    enable_nvdec = RTSP_ENABLE_NVDEC if enable_hwaccel is None else enable_hwaccel
    buffer_size = RTSP_BUFFER_SIZE
    open_timeout_ms = RTSP_OPEN_TIMEOUT_MS
    read_timeout_ms = RTSP_READ_TIMEOUT_MS
    hw_device = RTSP_HW_DEVICE

    if hasattr(cv2, "CAP_PROP_BUFFERSIZE"):
        params.extend([cv2.CAP_PROP_BUFFERSIZE, buffer_size])
    if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
        params.extend([cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, open_timeout_ms])
    if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
        params.extend([cv2.CAP_PROP_READ_TIMEOUT_MSEC, read_timeout_ms])
    if enable_nvdec and hasattr(cv2, "CAP_PROP_HW_ACCELERATION"):
        accel_any = getattr(cv2, "VIDEO_ACCELERATION_ANY", 1)
        params.extend([cv2.CAP_PROP_HW_ACCELERATION, int(accel_any)])
    if enable_nvdec and hw_device >= 0 and hasattr(cv2, "CAP_PROP_HW_DEVICE"):
        params.extend([cv2.CAP_PROP_HW_DEVICE, hw_device])

    return params


def _apply_rtsp_capture_fallback_props(
    cap: cv2.VideoCapture,
    *,
    enable_hwaccel: bool | None = None,
):
    enable_nvdec = RTSP_ENABLE_NVDEC if enable_hwaccel is None else enable_hwaccel
    buffer_size = RTSP_BUFFER_SIZE
    open_timeout_ms = RTSP_OPEN_TIMEOUT_MS
    read_timeout_ms = RTSP_READ_TIMEOUT_MS
    hw_device = RTSP_HW_DEVICE

    if hasattr(cv2, "CAP_PROP_BUFFERSIZE"):
        cap.set(cv2.CAP_PROP_BUFFERSIZE, buffer_size)
    if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, open_timeout_ms)
    if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, read_timeout_ms)
    if enable_nvdec and hasattr(cv2, "CAP_PROP_HW_ACCELERATION"):
        accel_any = getattr(cv2, "VIDEO_ACCELERATION_ANY", 1)
        cap.set(cv2.CAP_PROP_HW_ACCELERATION, int(accel_any))
    if enable_nvdec and hw_device >= 0 and hasattr(cv2, "CAP_PROP_HW_DEVICE"):
        cap.set(cv2.CAP_PROP_HW_DEVICE, hw_device)


def _is_opened(cap: cv2.VideoCapture | None) -> bool:
    if cap is None:
        return False
    try:
        return bool(cap.isOpened())
    except cv2.error:
        return False


def _release_if_needed(cap: cv2.VideoCapture | None):
    if cap is None:
        return
    try:
        cap.release()
    except cv2.error:
        pass


def open_video_capture(
    source_path: str,
    *,
    is_rtsp: bool | None = None,
    allow_hwaccel: bool | None = None,
) -> cv2.VideoCapture:
    global _NVDEC_CONFIG_LOGGED
    rtsp = is_rtsp_source(source_path) if is_rtsp is None else is_rtsp
    backend = getattr(cv2, "CAP_FFMPEG", None) if rtsp else None
    enable_nvdec = RTSP_ENABLE_NVDEC if allow_hwaccel is None else allow_hwaccel
    params = _build_capture_open_params(is_rtsp=rtsp, enable_hwaccel=enable_nvdec)

    with _CAPTURE_OPEN_LOCK:
        if rtsp:
            ffmpeg_options = _build_rtsp_ffmpeg_capture_options(enable_hwaccel=enable_nvdec)
            if enable_nvdec and not _NVDEC_CONFIG_LOGGED:
                print(
                    f"[VideoCapture] NVDEC requested for RTSP. "
                    f"ffmpeg_options='{ffmpeg_options}'"
                )
                _NVDEC_CONFIG_LOGGED = True

        cap = None
        if backend is not None:
            if params:
                try:
                    cap = cv2.VideoCapture(source_path, backend, params)
                except (TypeError, cv2.error):
                    cap = None
            if not _is_opened(cap):
                _release_if_needed(cap)
                cap = None
            if cap is None:
                try:
                    cap = cv2.VideoCapture(source_path, backend)
                except cv2.error:
                    cap = None
            if not _is_opened(cap):
                _release_if_needed(cap)
                cap = None

        if cap is None:
            cap = cv2.VideoCapture(source_path)
            if rtsp:
                _apply_rtsp_capture_fallback_props(cap, enable_hwaccel=enable_nvdec)

    return cap
