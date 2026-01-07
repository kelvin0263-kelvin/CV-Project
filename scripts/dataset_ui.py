import streamlit as st
import os
import shutil
import zipfile
import tempfile
import time
import sys

# Add current directory to path to import local modules
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(current_dir)

# Import the processing logic
from prepare_training_data import process_video

st.set_page_config(page_title="Dataset Generator", layout="wide")

st.title("🎥 Fisheye Training Data Generator")
st.markdown("""
This tool allows you to upload a fisheye video causing the script in the backend to:
1. **Defish** to 135° view.
2. **Detect People** (YOLOv8).
3. **Split Body Parts** (YOLO-Pose).
4. **Package** the results into a ZIP file.
""")

# File Uploader
uploaded_file = st.file_uploader("Upload MP4 Video", type=["mp4", "avi", "mov"])

if uploaded_file is not None:
    # Create a temporary directory for processing
    with tempfile.TemporaryDirectory() as temp_dir:
        st.info("Preparing workspace...")
        
        # Save uploaded video
        video_path = os.path.join(temp_dir, uploaded_file.name)
        with open(video_path, "wb") as f:
            f.write(uploaded_file.getbuffer())
        
        # Output directory
        output_dir = os.path.join(temp_dir, "dataset_output")
        os.makedirs(output_dir, exist_ok=True)
        
        # Process Button
        if st.button("Start Processing", type="primary"):
            progress_bar = st.progress(0)
            status_text = st.empty()
            
            try:
                # Redirect stdout to capture progress (optional, simplistic approach)
                status_text.text("Processing video... check terminal for details.")
                
                # Run the processing logic
                with st.spinner('Running AI Models (Defish -> YOLO -> Pose)... This may take a while.'):
                    process_video(video_path, output_dir)
                
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
                    label="⬇️ Download Dataset ZIP",
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
