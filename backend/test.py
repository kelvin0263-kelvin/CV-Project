
import numpy as np
import cvui_cpp_inference as m

print("module:", m.__file__)

core = m.InferenceCore(
    r"D:\FinalYearProjectTCK\CV-Project\backend\onnx\yolo26m-pose.onnx",
    r"D:\FinalYearProjectTCK\CV-Project\backend\onnx\best.onnx",
    r"D:\FinalYearProjectTCK\CV-Project\backend\onnx\best.labels.txt",
    r"D:\FinalYearProjectTCK\CV-Project\backend\bytetrack_custom.yaml",
    0, 1280, 224, 0.3, 0.5, 0.0
)

img = np.zeros((720, 1280, 3), dtype=np.uint8)

print("pose-only:", core.run_frame(img, 1, True)["people_count"])
print("with-cls:", core.run_frame(img, 2, False)["people_count"])


