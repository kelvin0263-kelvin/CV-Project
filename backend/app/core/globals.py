from typing import Any, Dict
import threading

# --------------------------------------------------------------------------
# Runtime-only in-memory state (NOT persisted in the database).
# These hold ephemeral video frame data and thread tracking.
# --------------------------------------------------------------------------

# Video frame buffers (the latest frames for broadcasting).
# Format:
# {
#   runtime_key: {
#     'original': jpeg_bytes,
#     'partition_X': jpeg_bytes,
#     '__meta__': {...},
#   }
# }
FrameBufferValue = bytes | dict[str, Any] | None
RuntimeFrameBuffer = dict[str, FrameBufferValue]
FRAME_BUFFERS: Dict[str, RuntimeFrameBuffer] = {}

# Producer thread runtime registries (keyed by runtime_key)
PRODUCER_THREADS: Dict[str, threading.Thread] = {}
PRODUCER_STOP_EVENTS: Dict[str, threading.Event] = {}
PRODUCER_META: Dict[str, dict] = {}
PRODUCER_LOCK = threading.Lock()
