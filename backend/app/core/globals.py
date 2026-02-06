from typing import Dict

# --------------------------------------------------------------------------
# Runtime-only in-memory state (NOT persisted in the database).
# These hold ephemeral video frame data and thread tracking.
# --------------------------------------------------------------------------

# Video Frame Buffers (The latest frames for broadcasting)
# Format: { source_path: { 'original': b64_str, 'partition_X': b64_str, '__meta__': {...} } }
FRAME_BUFFERS: Dict[str, Dict[str, str]] = {}

# Active Producer Threads Tracker
ACTIVE_PRODUCERS: Dict[str, bool] = {}
