import hashlib
import os
import sys
import tempfile
import time
import zipfile

os.environ.setdefault("STREAMLIT_SERVER_FILE_WATCHER_TYPE", "none")

import cv2
import streamlit as st

# Streamlit defaults to 200MB upload limit. To increase, use:
# streamlit run scripts/dataset_ui.py --server.maxUploadSize 1024


# Add current directory to path to import local modules
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(current_dir)

# Import the processing logic
from prepare_training_data import (
    DEFAULT_VIEW_CONFIG,
    build_view_configs,
    generate_defish_preview,
    process_video,
)

SUPPORTED_VIDEO_EXTS = (".mp4", ".avi", ".mov", ".mkv")
UPLOADS_DIR = os.path.abspath(os.path.join(current_dir, "..", "..", "uploads"))
DATASET_OUTPUTS_DIR = os.path.join(current_dir, "dataset_output")


def list_uploaded_videos():
    if not os.path.isdir(UPLOADS_DIR):
        return []
    return sorted(
        [
            f
            for f in os.listdir(UPLOADS_DIR)
            if f.lower().endswith(SUPPORTED_VIDEO_EXTS)
        ]
    )


def format_file_detail(filename: str) -> str:
    full_path = os.path.join(UPLOADS_DIR, filename)
    try:
        size_mb = os.path.getsize(full_path) / (1024 * 1024)
        return f"{filename} ({size_mb:.1f} MB)"
    except OSError:
        return filename


def make_run_output_dir(label: str) -> str:
    """Create a persistent output directory under scripts/dataset_output."""
    base_name = os.path.splitext(os.path.basename(label))[0]
    safe_name = "".join(
        ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in base_name
    ).strip("_")
    safe_name = safe_name or "dataset"
    run_dir = os.path.join(DATASET_OUTPUTS_DIR, f"{safe_name}_{int(time.time())}")
    os.makedirs(run_dir, exist_ok=True)
    return run_dir


def cache_uploaded_video(uploaded_file) -> str:
    """Persist uploaded content to a stable temp file so OpenCV can preview it."""
    suffix = os.path.splitext(uploaded_file.name)[1] or ".mp4"
    file_buffer = uploaded_file.getbuffer()
    file_hash = hashlib.md5(file_buffer).hexdigest()[:12]
    temp_path = os.path.join(tempfile.gettempdir(), f"dataset_ui_{file_hash}{suffix}")
    if not os.path.exists(temp_path):
        with open(temp_path, "wb") as temp_file:
            temp_file.write(file_buffer)
    return temp_path


def resolve_video_path(uploaded_file, selected_existing_path):
    if uploaded_file is not None:
        return cache_uploaded_video(uploaded_file)
    return selected_existing_path


def convert_bgr_to_rgb(image):
    if image is None:
        return None
    return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)


def render_preview_panel(video_path: str, view_configs):
    fisheye_preview, defish_preview = generate_defish_preview(
        video_path,
        view_configs=view_configs,
    )

    left_col, right_col = st.columns(2)
    if fisheye_preview is not None:
        left_col.image(
            convert_bgr_to_rgb(fisheye_preview),
            caption="Fisheye preview with selected view outline",
            use_container_width=True,
        )
    if defish_preview is not None:
        right_col.image(
            convert_bgr_to_rgb(defish_preview),
            caption="Defished preview for the current angle",
            use_container_width=True,
        )


st.set_page_config(page_title="Dataset Generator", layout="wide")

st.title("Fisheye Training Data Generator")
st.markdown(
    """
This tool allows you to upload a fisheye video causing the script in the backend to:
1. **Defish** to the selected view angle (optional).
2. **Detect People** (YOLOv8).
3. **Split Body Parts** (YOLO-Pose).
4. **Package** the results into a ZIP file.
"""
)

source_choice = st.radio(
    "Choose video source",
    ("Upload new video", "Use workspace/uploads"),
    horizontal=True,
)

uploaded_file = None
selected_existing = None
selected_existing_path = None
video_label = None
preview_video_path = None

if source_choice == "Upload new video":
    uploaded_file = st.file_uploader(
        "Upload MP4/AVI/MOV",
        type=[ext.replace(".", "") for ext in SUPPORTED_VIDEO_EXTS],
    )
    if uploaded_file is not None:
        video_label = uploaded_file.name

elif source_choice == "Use workspace/uploads":
    st.info(f"Looking in {UPLOADS_DIR}")
    existing_files = list_uploaded_videos()
    if not existing_files:
        st.warning(
            "No video files found in workspace/uploads. "
            "Upload via SCP or file browser, then re-run."
        )
    else:
        selected_existing = st.selectbox(
            "Select a video already in workspace/uploads",
            existing_files,
            format_func=format_file_detail,
        )
        if selected_existing:
            selected_existing_path = os.path.join(UPLOADS_DIR, selected_existing)
            video_label = selected_existing
            st.caption(f"Using: {selected_existing_path}")

if video_label:
    preview_video_path = resolve_video_path(uploaded_file, selected_existing_path)
    st.success(f"Ready to process: {video_label}")

    defish_enabled = st.checkbox(
        "Apply fisheye remap (defish)",
        value=True,
        help="Uncheck to use raw frames without defishing",
    )

    selected_view_configs = None
    if defish_enabled:
        angle_z = st.slider(
            "Defish horizontal angle (angle_z)",
            min_value=0,
            max_value=360,
            value=DEFAULT_VIEW_CONFIG["angle_z"],
            step=5,
            help="Rotate around the fisheye image to choose the output direction.",
        )
        with st.expander("Advanced defish settings", expanded=False):
            angle_up = st.slider(
                "Vertical tilt (angle_up)",
                min_value=-90,
                max_value=90,
                value=DEFAULT_VIEW_CONFIG["angle_up"],
                step=1,
            )
            zoom = st.slider(
                "Zoom / output field of view",
                min_value=30,
                max_value=150,
                value=DEFAULT_VIEW_CONFIG["zoom"],
                step=1,
            )

        selected_view_configs = build_view_configs(
            angle_z=angle_z,
            angle_up=angle_up,
            zoom=zoom,
        )
        current_view = selected_view_configs[0]
        st.caption(
            "Current defish config: "
            f"angle_z={current_view['angle_z']} deg, "
            f"angle_up={current_view['angle_up']} deg, "
            f"zoom={current_view['zoom']} deg"
        )

        if preview_video_path:
            st.subheader("Preview")
            st.caption(
                "This preview uses one sampled frame from the selected video so you can "
                "check the current angle before processing."
            )
            try:
                with st.spinner("Generating preview..."):
                    render_preview_panel(preview_video_path, selected_view_configs)
            except Exception as preview_error:
                st.warning(f"Could not generate preview: {preview_error}")

    if st.button("Start Processing", type="primary"):
        progress_bar = st.progress(0)
        status_text = st.empty()

        try:
            status_text.text("Preparing workspace...")
            with tempfile.TemporaryDirectory() as temp_dir:
                video_path = preview_video_path
                if not video_path or not os.path.exists(video_path):
                    raise FileNotFoundError(f"Selected video not found: {video_path}")

                output_dir = make_run_output_dir(video_label or "dataset")

                status_text.text("Processing video... check terminal for details.")
                with st.spinner(
                    "Running AI Models (Defish -> YOLO -> Pose)... This may take a while."
                ):
                    process_video(
                        video_path,
                        output_dir,
                        defish=defish_enabled,
                        view_configs=selected_view_configs,
                    )

                status_text.success("Processing Complete!")
                progress_bar.progress(100)
                st.caption(f"Saved dataset to: {output_dir}")

                st.info("Zipping results...")
                zip_path = os.path.join(temp_dir, "training_data.zip")

                with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
                    for root, dirs, files in os.walk(output_dir):
                        for file in files:
                            file_path = os.path.join(root, file)
                            arcname = os.path.relpath(file_path, output_dir)
                            zipf.write(file_path, arcname)

                with open(zip_path, "rb") as zip_file:
                    zip_data = zip_file.read()

                st.download_button(
                    label="Download Dataset ZIP",
                    data=zip_data,
                    file_name=f"dataset_{int(time.time())}.zip",
                    mime="application/zip",
                )

                st.subheader("Preview Generated Images")
                preview_dirs = ["full_body", "upper_body", "lower_body", "legs"]
                cols = st.columns(4)

                for idx, subdir in enumerate(preview_dirs):
                    full_subdir = os.path.join(output_dir, subdir)
                    if os.path.exists(full_subdir):
                        files = os.listdir(full_subdir)
                        if files:
                            img_path = os.path.join(full_subdir, files[0])
                            cols[idx].image(
                                img_path,
                                caption=f"{subdir} ({len(files)} items)",
                            )

        except Exception as e:
            st.error(f"An error occurred: {e}")
            st.exception(e)

st.divider()
st.caption("Powered by YOLOv8 & DefishVideoCV")
