import cv2
import numpy as np
import FisheyeToPlanar 
from background_subtraction import BackgroundSubtraction 
from motion_detection_utils import add_motion_alert_border
from logger import log 

class FisheyeMultiView:
    """
    Handles the dewarping of a fisheye video frame into multiple planar views
    based on a given configuration.
    """

    def __init__(self, fisheye_frame_shape, view_configs, show_original=True, motion_detection_enabled=False, perimeter_zones={}, use_cuda=False, downscale_size=(640, 360)):
        """
        Initializes the processor and pre-calculates all necessary transformation maps.

        Args:
            fisheye_frame_shape (tuple): The (height, width) of the input fisheye frame.
            view_configs (list): A list of dictionaries, where each dict defines a view
                                 with 'angle_z', 'angle_up', and 'zoom'.
            show_original (bool): Flag to determine if the original fisheye view should be returned.
        """
        print("Initializing FisheyeMultiView...")
        if not view_configs:
            raise ValueError("View configurations cannot be empty for FisheyeMultiView.")

        self.view_configs = view_configs
        self.show_original = show_original
        self.dewarp_maps = []
        self.gpu_dewarp_maps = []  # Holds uploaded maps when CUDA is enabled
        self.use_cuda = bool(use_cuda and hasattr(cv2, "cuda") and cv2.cuda.getCudaEnabledDeviceCount() > 0)
        # When using CUDA, downscale on-GPU before downloading to reduce copy cost
        self.downscale_size = downscale_size if self.use_cuda else None

        # --- Calculate cropping parameters ---
        h, w = fisheye_frame_shape[:2]
        side_length = min(h, w)
        self.crop_offset = (w - side_length) // 2
        self.cropped_frame_shape = (side_length, side_length)
        
        # --- Pre-calculate all transformation maps ---
        self._create_all_maps()


        self.motion_detection_enabled = motion_detection_enabled
        self.perimeter_zones = perimeter_zones

        if self.motion_detection_enabled:
            print(f"Motion detection enabled. Initializing {len(view_configs)} background subtractors.")
            self.bg_subtractors = [BackgroundSubtraction() for _ in view_configs]
        else:
            self.bg_subtractors = []

    def _create_all_maps(self):
        """Generates a transformation map for each view configuration and uploads to GPU if available."""
        print(f"Creating {len(self.view_configs)} dewarp maps...")
        # High-res remap target; keep as requested (height, width)
        output_shape = (1920,2560)

        for config in self.view_configs:
            if config is None:
                self.dewarp_maps.append(None)
                self.gpu_dewarp_maps.append(None)
                continue
            
            pan_angle = config.get('angle_z', 0)
            tilt_angle = config.get('angle_up', 0)
            zoom_fov = config.get('zoom', 90)

            try:
                # This function is assumed to exist in your FisheyeToPlanar library
                map_x, map_y = FisheyeToPlanar.create_remap_map(
                    fisheye_shape=self.cropped_frame_shape,
                    output_shape=output_shape,
                    i_fov_deg = 180,
                    o_fov_deg=zoom_fov,
                    yaw_deg=0,
                    pitch_deg=tilt_angle,
                    roll_deg=pan_angle,
                )
                self.dewarp_maps.append((map_x, map_y))
                if self.use_cuda:
                    # Upload maps to GPU once to avoid per-frame transfers
                    map_x_gpu = cv2.cuda_GpuMat()
                    map_y_gpu = cv2.cuda_GpuMat()
                    map_x_gpu.upload(map_x)
                    map_y_gpu.upload(map_y)
                    self.gpu_dewarp_maps.append((map_x_gpu, map_y_gpu))
                else:
                    self.gpu_dewarp_maps.append(None)
            except Exception as e:
                print(f"Failed to create map for config {config}: {e}")
                # Add a None placeholder to maintain index alignment
                self.dewarp_maps.append(None)
                self.gpu_dewarp_maps.append(None)
        
        print("FisheyeMultiView initialization complete.")

    @staticmethod
    def pad_to_size(img, target_width, target_height, color=(0, 0, 0)):
        """
        Resizes an image to fit within the target dimensions while maintaining aspect ratio,
        then pads with black bars to create a letterbox/pillarbox effect.
        """
        h, w = img.shape[:2]
        
        # Calculate the scaling factor
        scale = min(target_width / w, target_height / h)
        
        # New dimensions after resizing
        new_w, new_h = int(w * scale), int(h * scale)
        
        resized_img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
        
        # Create a new black canvas
        padded_img = np.full((target_height, target_width, 3), color, dtype=np.uint8)
        
        # Paste the resized image onto the center of the canvas
        start_x = (target_width - new_w) // 2
        start_y = (target_height - new_h) // 2
        padded_img[start_y:start_y + new_h, start_x:start_x + new_w] = resized_img
        
        return padded_img

    def process_frame(self, frame, overlay, view_id=None):
        """
        Processes a single raw fisheye frame and returns configured views.
        Args:
            frame (np.ndarray): The raw fisheye video frame.
            view_id (str, optional): If set (e.g., 'partition_0'), only process this view.
        """
        processed_frames = {}
        processed_masks = {}
        processed_motion_flag = {}
        
        # Always return original if specifically requested or no view_id (backward compat)
        if view_id is None or view_id == 'original':
             processed_frames['original'] = frame.copy()

        # --- Crop the frame to the center square ---
        side_length = self.cropped_frame_shape[0]
        # Safety check for crop
        if frame.shape[1] < self.crop_offset + side_length:
             # If frame is smaller than expected, just use center crop
             self.crop_offset = (frame.shape[1] - side_length) // 2
        
        cropped_frame = frame[:, self.crop_offset:self.crop_offset + side_length]

        # print(f"Processing fisheye frame of shape {frame.shape} into {len(self.dewarp_maps)} views...")

        # --- Generate each dewarped partition ---
        for i, dewarp_map in enumerate(self.dewarp_maps):
            current_key = f"partition_{i}"
            if view_id is not None and view_id != 'original' and view_id != current_key:
                continue

            if dewarp_map is not None:
                map_x, map_y = dewarp_map

                if self.use_cuda and self.gpu_dewarp_maps[i] is not None:
                    # GPU remap then (optionally) GPU resize before a single download
                    map_x_gpu, map_y_gpu = self.gpu_dewarp_maps[i]
                    gpu_src = cv2.cuda_GpuMat()
                    gpu_src.upload(cropped_frame)
                    gpu_planar = cv2.cuda.remap(
                        gpu_src, map_x_gpu, map_y_gpu,
                        interpolation=cv2.INTER_LINEAR,
                        borderMode=cv2.BORDER_CONSTANT
                    )
                    if self.downscale_size:
                        # Note: cv2 uses (width, height)
                        target_w, target_h = self.downscale_size
                        gpu_planar = cv2.cuda.resize(gpu_planar, (target_w, target_h), interpolation=cv2.INTER_AREA)
                    planar_view = gpu_planar.download()
                else:
                    planar_view = cv2.remap(
                        cropped_frame, map_x, map_y,
                        interpolation=cv2.INTER_LINEAR,
                        borderMode=cv2.BORDER_CONSTANT
                    )
                
                # ROTATE 180 degrees (Correct for ceiling mount)
                planar_view = cv2.rotate(planar_view, cv2.ROTATE_180)

                motion_mask = None
                # --- Handle motion detection if enabled ---
                if self.motion_detection_enabled and i < len(self.bg_subtractors):
                    subtractor = self.bg_subtractors[i]

                    current_view_zones = self.view_configs[i].get('zones', {})

                    detections, motion_mask = subtractor.get_detections(planar_view.copy(), zones=current_view_zones , bbox_thresh=50)
                    
                    # Draw bounding boxes on the view
                    if detections is not None:
                        planar_view = add_motion_alert_border(planar_view) # New way
                        processed_motion_flag[f"partition_{i}"] = True
                    else:
                        processed_motion_flag[f"partition_{i}"] = False
                    

                processed_frames[f"partition_{i}"] = planar_view

                if motion_mask is not None:
                    # if detections is not None:
                    #     draw_bboxes(motion_mask, detections)

                    processed_masks[f"partition_{i}"] = motion_mask

        # --- Include the original fisheye view if requested ---
        if overlay and self.show_original:
            # Overlay the original fisheye frame on the processed views
            output_shape_for_lib = (270*2, 480*2)
            for config in self.view_configs:
                if config is None:
                    continue
                pan_angle = config.get('angle_z', 0)
                tilt_angle = config.get('angle_up', 0)
                zoom_fov = config.get('zoom', 90)

                boundary_pts = FisheyeToPlanar.get_view_boundary_on_fisheye(
                    fisheye_shape=self.cropped_frame_shape,
                    output_shape=output_shape_for_lib,
                    i_fov_deg = 180,
                    o_fov_deg=zoom_fov,
                    yaw_deg=0,
                    pitch_deg=tilt_angle,
                    roll_deg=pan_angle,
                )
                
                pts = boundary_pts.reshape((-1, 1, 2)).astype(np.int32)
                pts[:, :, 0] += self.crop_offset
                cv2.polylines(frame, [pts], isClosed=True, color=(0, 255, 255), thickness=2)

        if self.show_original:
            processed_frames["original"] = self.pad_to_size(frame, 640, 360) 
            # processed_frames["original"] = cv2.resize(frame, (640, 360)) 

        return processed_frames, processed_masks, processed_motion_flag