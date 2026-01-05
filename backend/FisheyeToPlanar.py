import cv2
import numpy as np

def create_remap_map(fisheye_shape, output_shape, i_fov_deg, o_fov_deg, yaw_deg, pitch_deg, roll_deg):
    """
    Creates a coordinate mapping from a fisheye view to a perspective view.
    Handles non-square output aspect ratios correctly.
    """
    i_h, i_w = fisheye_shape
    o_h, o_w = output_shape

    # Assume the provided o_fov_deg is the VERTICAL field of view.
    v_fov_rad = np.deg2rad(o_fov_deg)
    
    # Calculate the boundaries of the 3D projection plane based on the vertical FOV and aspect ratio
    y_range = np.tan(v_fov_rad / 2.0)
    x_range = y_range * (o_w / o_h) # Adjust width based on aspect ratio

    # Create a grid of coordinates on the projection plane
    x_cam, y_cam = np.meshgrid(
        np.linspace(-x_range, x_range, num=o_w, dtype=np.float32),
        np.linspace(y_range, -y_range, num=o_h, dtype=np.float32) # y is inverted in image coordinates
    )
    z_cam = np.ones_like(x_cam)
    
    xyz_grid = np.stack([x_cam, y_cam, z_cam], axis=-1)

    # Calculate combined rotation matrix
    yaw_rad, pitch_rad, roll_rad = np.deg2rad(yaw_deg), np.deg2rad(pitch_deg), np.deg2rad(roll_deg)
    cos_p, sin_p = np.cos(pitch_rad), np.sin(pitch_rad)
    Rx = np.array([[1, 0, 0], [0, cos_p, -sin_p], [0, sin_p, cos_p]])
    cos_y, sin_y = np.cos(yaw_rad), np.sin(yaw_rad)
    Ry = np.array([[cos_y, 0, sin_y], [0, 1, 0], [-sin_y, 0, cos_y]])
    cos_r, sin_r = np.cos(roll_rad), np.sin(roll_rad)
    Rz = np.array([[cos_r, -sin_r, 0], [sin_r, cos_r, 0], [0, 0, 1]])
    R = Rz @ Rx @ Ry
    
    # Rotate the 3D grid
    rotated_xyz = xyz_grid @ R.T
    
    # Project 3D vectors to fisheye sphere
    x_rot, y_rot, z_rot = rotated_xyz[..., 0], rotated_xyz[..., 1], rotated_xyz[..., 2]
    theta = np.arctan2(y_rot, x_rot)
    phi = np.arctan2(np.sqrt(x_rot**2 + y_rot**2), z_rot)
    
    # Map spherical coordinates to 2D fisheye image
    i_fov_rad = np.deg2rad(i_fov_deg)
    r = phi * min(i_h, i_w) / i_fov_rad
    map_x = 0.5 * i_w + r * np.cos(theta)
    
    # FIX: The sign was incorrect, causing a vertical flip.
    # It should be a minus to map the top of the view (positive y_rot)
    # to the top of the image (smaller map_y values).
    map_y = 0.5 * i_h - r * np.sin(theta)
    
    return map_x.astype(np.float32), map_y.astype(np.float32)

def get_view_boundary_on_fisheye(fisheye_shape, output_shape, i_fov_deg, o_fov_deg, yaw_deg, pitch_deg, roll_deg):
    """
    Calculates the 4 corner points of the planar view projected onto the fisheye image.
    """
    i_h, i_w = fisheye_shape
    o_h, o_w = output_shape
    
    v_fov_rad = np.deg2rad(o_fov_deg)
    y_range = np.tan(v_fov_rad / 2.0)
    x_range = y_range * (o_w / o_h)

    # Define the 4 corners of the projection plane
    corners_3d = np.array([
        [-x_range,  y_range, 1.0],  # Top-left
        [ x_range,  y_range, 1.0],  # Top-right
        [ x_range, -y_range, 1.0],  # Bottom-right
        [-x_range, -y_range, 1.0]   # Bottom-left
    ])
    
    yaw_rad, pitch_rad, roll_rad = np.deg2rad(yaw_deg), np.deg2rad(pitch_deg), np.deg2rad(roll_deg)
    cos_p, sin_p = np.cos(pitch_rad), np.sin(pitch_rad)
    Rx = np.array([[1, 0, 0], [0, cos_p, -sin_p], [0, sin_p, cos_p]])
    cos_y, sin_y = np.cos(yaw_rad), np.sin(yaw_rad)
    Ry = np.array([[cos_y, 0, sin_y], [0, 1, 0], [-sin_y, 0, cos_y]])
    cos_r, sin_r = np.cos(roll_rad), np.sin(roll_rad)
    Rz = np.array([[cos_r, -sin_r, 0], [sin_r, cos_r, 0], [0, 0, 1]])
    R = Rz @ Rx @ Ry
    
    rotated_xyz = corners_3d @ R.T
    
    x_rot, y_rot, z_rot = rotated_xyz[..., 0], rotated_xyz[..., 1], rotated_xyz[..., 2]
    theta = np.arctan2(y_rot, x_rot)
    phi = np.arctan2(np.sqrt(x_rot**2 + y_rot**2), z_rot)
    
    i_fov_rad = np.deg2rad(i_fov_deg)
    r = phi * min(i_h, i_w) / i_fov_rad
    
    map_x = 0.5 * i_w + r * np.cos(theta)
    # This negation is correct for mapping to standard image coordinates (y increases downwards)
    # and accounting for the flip in the main script.
    map_y = 0.5 * i_h - r * np.sin(theta)
    
    return np.stack([map_x, map_y], axis=-1)

def create_maps_for_angles(fisheye_shape, output_shape, i_fov_deg, o_fov_deg, o_z, o_v):
    """
    Pre-calculates all necessary remap maps for a list of angles.
    """
    maps = []
    for deg in o_z:
        # Assuming o_fov=90 (vertical), i_fov=180, and yaw (o_u)=0 for all maps
        remap_map = create_remap_map(fisheye_shape, output_shape, i_fov_deg, o_fov_deg, 0, o_v, deg)
        maps.append(remap_map)
    return maps

def fisheye2Planar(fisheye_image, output_shape=(480, 480), i_fov=180, o_fov=90, o_u=0, o_v=0, o_z=0):
    """ 
    Converts a fisheye image to a planar view. Retained for compatibility. 
    """
    map_x, map_y = create_remap_map(fisheye_image.shape[:2], output_shape, i_fov, o_fov, o_u, o_v, o_z)
    return cv2.remap(fisheye_image, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
