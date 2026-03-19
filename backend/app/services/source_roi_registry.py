import threading


_source_detection_roi_map: dict[str, dict] = {}
_source_detection_roi_lock = threading.Lock()


def replace_source_detection_rois(next_map: dict[str, dict]) -> None:
    global _source_detection_roi_map
    with _source_detection_roi_lock:
        _source_detection_roi_map = dict(next_map)


def get_source_detection_roi(runtime_key: str, view_key: str) -> dict | None:
    with _source_detection_roi_lock:
        roi = _source_detection_roi_map.get(f"{runtime_key}||{view_key}")
        return dict(roi) if isinstance(roi, dict) else None
