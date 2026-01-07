from typing import List, Dict

# Global In-Memory Databases
CAMERAS_DB = []  # List[CameraSource]

# Config for active streams
# Format: { camera_id: { 'source_path': str, 'view_index': int, 'is_fisheye': bool } }
STREAM_CONFIGS: Dict[str, dict] = {}

# Video Frame Buffers (The latest frames for broadcasting)
# Format: { source_path: { 'original': b64_str, 'partition_X': b64_str, '__meta__': {...} } }
FRAME_BUFFERS: Dict[str, Dict[str, str]] = {}

# Active Producer Threads Tracker
ACTIVE_PRODUCERS: Dict[str, bool] = {} 
