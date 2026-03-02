from pathlib import Path
import numpy as np
from onnx import numpy_helper
import onnx

base = Path(__file__).resolve().parent  # backend/
inp = base / "onnx" / "yolo26m-pose.onnx"
out = base / "onnx" / "yolo26m-pose.opencv.onnx"
out.parent.mkdir(parents=True, exist_ok=True)

TARGET_K = 50  # 关键：选一个明显更小的数，确保 K < dim

m = onnx.load(str(inp))
init_map = {i.name: i for i in m.graph.initializer}
patched = 0

for node in m.graph.node:
    if node.op_type != "TopK" or len(node.input) < 2:
        continue

    k_name = node.input[1]

    # Case 1: K comes from initializer
    if k_name in init_map:
        arr = np.array(numpy_helper.to_array(init_map[k_name]), dtype=np.int64)

        # 有些 K 是标量，有些是 shape=(1,)；统一写进去
        arr[...] = np.int64(TARGET_K)

        init_map[k_name].CopyFrom(numpy_helper.from_array(arr, name=k_name))
        patched += 1
        continue

    # Case 2: K comes from Constant node
    for c in m.graph.node:
        if c.op_type == "Constant" and c.output and c.output[0] == k_name:
            for a in c.attribute:
                if a.name == "value":
                    arr = np.array(numpy_helper.to_array(a.t), dtype=np.int64)
                    arr[...] = np.int64(TARGET_K)
                    a.t.CopyFrom(numpy_helper.from_array(arr))
                    patched += 1

onnx.save(m, str(out))
print("TARGET_K =", TARGET_K)
print("patched_topk_inputs =", patched)
print("saved =", out)
