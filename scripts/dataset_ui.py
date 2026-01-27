import streamlit as st
import os
import shutil
import zipfile
import tempfile
import time
import sys

# Streamlit defaults to 200MB upload limit. To increase, use:
# streamlit run scripts/dataset_ui.py --server.maxUploadSize 1024


# Add current directory to path to import local modules
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(current_dir)

# Import the processing logic
from prepare_training_data import process_video

SUPPORTED_VIDEO_EXTS = (".mp4", ".avi", ".mov", ".mkv")
UPLOADS_DIR = os.path.abspath(os.path.join(current_dir, "..", "..", "uploads"))


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


st.set_page_config(page_title="Dataset Generator", layout="wide")

st.title(" Fisheye Training Data Generator")
st.markdown("""
This tool allows you to upload a fisheye video causing the script in the backend to:
1. **Defish** to 135° view (optional).
2. **Detect People** (YOLOv8).
3. **Split Body Parts** (YOLO-Pose).
4. **Package** the results into a ZIP file.
""")

source_choice = st.radio(
    "Choose video source",
    ("Upload new video", "Use workspace/uploads"),
    horizontal=True,
)

uploaded_file = None
selected_existing = None
selected_existing_path = None
video_label = None

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
    st.success(f"Ready to process: {video_label}")

    defish_enabled = st.checkbox(
        "Apply fisheye remap (defish to 135°)",
        value=True,
        help="Uncheck to use raw frames without defishing",
    )

    # Process Button
    if st.button("Start Processing", type="primary"):
        progress_bar = st.progress(0)
        status_text = st.empty()

        try:
            status_text.text("Preparing workspace...")
            with tempfile.TemporaryDirectory() as temp_dir:
                # Save uploaded video to temp if needed
                if uploaded_file is not None:
                    video_path = os.path.join(temp_dir, uploaded_file.name)
                    with open(video_path, "wb") as f:
                        f.write(uploaded_file.getbuffer())
                else:
                    video_path = selected_existing_path
                    if not video_path or not os.path.exists(video_path):
                        raise FileNotFoundError(
                            f"Selected video not found: {video_path}"
                        )

                # Output directory
                output_dir = os.path.join(temp_dir, "dataset_output")
                os.makedirs(output_dir, exist_ok=True)

                # Run the processing logic
                status_text.text("Processing video... check terminal for details.")
                with st.spinner(
                    'Running AI Models (Defish -> YOLO -> Pose)... This may take a while.'
                ):
                    process_video(video_path, output_dir, defish=defish_enabled)

                status_text.success("Processing Complete!")
                progress_bar.progress(100)

                # Zip the results
                st.info("Zipping results...")
                zip_path = os.path.join(temp_dir, "training_data.zip")

                with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
                    for root, dirs, files in os.walk(output_dir):
                        for file in files:
                            file_path = os.path.join(root, file)
                            arcname = os.path.relpath(file_path, output_dir)
                            zipf.write(file_path, arcname)

                # Read zip for download
                with open(zip_path, "rb") as f:
                    zip_data = f.read()

                st.download_button(
                    label="⬇ Download Dataset ZIP",
                    data=zip_data,
                    file_name=f"dataset_{int(time.time())}.zip",
                    mime="application/zip"
                )

                # Preview some images
                st.subheader("Preview Generated Images")
                preview_dirs = ['full_body', 'upper_body', 'lower_body', 'legs']
                cols = st.columns(4)

                for idx, subdir in enumerate(preview_dirs):
                    full_subdir = os.path.join(output_dir, subdir)
                    if os.path.exists(full_subdir):
                        files = os.listdir(full_subdir)
                        if files:
                            # Show first image
                            img_path = os.path.join(full_subdir, files[0])
                            cols[idx].image(img_path, caption=f"{subdir} ({len(files)} items)")

        except Exception as e:
            st.error(f"An error occurred: {e}")
            st.exception(e)

st.divider()
st.caption("Powered by YOLOv8 & DefishVideoCV")
