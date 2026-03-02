#include <string>

#include <pybind11/pybind11.h>
#include "inference_core.hpp"

namespace py = pybind11;

PYBIND11_MODULE(cvui_cpp_inference, m) {
    m.doc() = "CV-UI C++ inference core exposed to Python via pybind11.";

    py::class_<InferenceCore>(m, "InferenceCore")
        .def(
            py::init<std::string, std::string, std::string, std::string, int, int, int, float, float, float>(),
            py::arg("pose_model_path"),
            py::arg("classifier_model_path"),
            py::arg("class_names_path"),
            py::arg("tracker_config_path"),
            py::arg("device_id") = 0,
            py::arg("pose_imgsz") = 1280,
            py::arg("cls_imgsz") = 224,
            py::arg("det_conf") = 0.30F,
            py::arg("det_iou") = 0.50F,
            py::arg("cls_conf_min") = 0.0F
        )
        .def(
            "run_frame",
            &InferenceCore::run_frame,
            py::arg("image"),
            py::arg("frame_index"),
            py::arg("skip_classification") = false
        )
        .def("health", &InferenceCore::health);
}
