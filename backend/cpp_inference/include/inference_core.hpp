#pragma once

#include <memory>
#include <string>

#include <pybind11/numpy.h>
#include <pybind11/pybind11.h>

namespace py = pybind11;

class InferenceCore {
public:
    InferenceCore(std::string pose_model_path,
                  std::string classifier_model_path,
                  std::string class_names_path,
                  std::string tracker_config_path,
                  int device_id,
                  int pose_imgsz,
                  int cls_imgsz,
                  float det_conf,
                  float det_iou,
                  float cls_conf_min);
    ~InferenceCore();

    py::dict run_frame(const py::array& image, int frame_index, bool skip_classification);
    py::dict health() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
