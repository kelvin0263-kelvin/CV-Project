from typing import Dict
import threading

# --------------------------------------------------------------------------
# Runtime-only in-memory state (NOT persisted in the database).
# These hold ephemeral video frame data and thread tracking.
# --------------------------------------------------------------------------

# Video Frame Buffers (The latest frames for broadcasting)
# Format: { runtime_key: { 'original': b64_str, 'partition_X': b64_str, '__meta__': {...} } }
FRAME_BUFFERS: Dict[str, Dict[str, str]] = {}

# Producer thread runtime registries (keyed by runtime_key)
PRODUCER_THREADS: Dict[str, threading.Thread] = {}
PRODUCER_STOP_EVENTS: Dict[str, threading.Event] = {}
PRODUCER_META: Dict[str, dict] = {}
PRODUCER_LOCK = threading.Lock()
