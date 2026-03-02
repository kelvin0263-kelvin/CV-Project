#include "inference_core.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <ByteTrack/BYTETracker.h>
#include <ByteTrack/Object.h>
#include <onnxruntime_cxx_api.h>
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>

namespace {

constexpr int kPoseKeypointCount = 17;
constexpr int kPoseMinChannels = 5 + (kPoseKeypointCount * 3);
constexpr float kEps = 1e-6F;
constexpr int kMinPersonHeightPx = 160;
constexpr int kMinCropDim = 32;

struct TrackerConfig {
    float track_high_thresh = 0.45F;
    float new_track_thresh = 0.4F;
    float match_thresh = 0.8F;
    int track_buffer = 30;
};

struct LetterboxInfo {
    float scale = 1.0F;
    int pad_x = 0;
    int pad_y = 0;
};

struct PoseCandidate {
    cv::Rect2f box;
    float conf = 0.0F;
    std::array<cv::Point3f, kPoseKeypointCount> keypoints{};
};

static std::string trim(const std::string& input) {
    const auto first = input.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) {
        return "";
    }
    const auto last = input.find_last_not_of(" \t\r\n");
    return input.substr(first, (last - first) + 1);
}

static TrackerConfig load_tracker_config(const std::string& path) {
    TrackerConfig cfg;
    std::ifstream file(path);
    if (!file.is_open()) {
        return cfg;
    }

    std::string line;
    while (std::getline(file, line)) {
        const auto hash_pos = line.find('#');
        if (hash_pos != std::string::npos) {
            line = line.substr(0, hash_pos);
        }
        line = trim(line);
        if (line.empty()) {
            continue;
        }
        const auto colon = line.find(':');
        if (colon == std::string::npos) {
            continue;
        }
        const std::string key = trim(line.substr(0, colon));
        const std::string value = trim(line.substr(colon + 1));
        if (key == "match_thresh") {
            try {
                cfg.match_thresh = std::stof(value);
            } catch (...) {
            }
        } else if (key == "track_high_thresh") {
            try {
                cfg.track_high_thresh = std::stof(value);
            } catch (...) {
            }
        } else if (key == "new_track_thresh") {
            try {
                cfg.new_track_thresh = std::stof(value);
            } catch (...) {
            }
        } else if (key == "track_buffer") {
            try {
                cfg.track_buffer = std::stoi(value);
            } catch (...) {
            }
        }
    }

    if (cfg.track_high_thresh <= 0.0F || cfg.track_high_thresh > 1.0F) {
        cfg.track_high_thresh = 0.45F;
    }
    if (cfg.new_track_thresh <= 0.0F || cfg.new_track_thresh > 1.0F) {
        cfg.new_track_thresh = 0.4F;
    }
    if (cfg.match_thresh <= 0.0F || cfg.match_thresh > 1.0F) {
        cfg.match_thresh = 0.8F;
    }
    if (cfg.track_buffer < 1) {
        cfg.track_buffer = 30;
    }
    return cfg;
}

static float iou(const cv::Rect2f& a, const cv::Rect2f& b) {
    const float x1 = std::max(a.x, b.x);
    const float y1 = std::max(a.y, b.y);
    const float x2 = std::min(a.x + a.width, b.x + b.width);
    const float y2 = std::min(a.y + a.height, b.y + b.height);

    const float inter_w = std::max(0.0F, x2 - x1);
    const float inter_h = std::max(0.0F, y2 - y1);
    const float inter = inter_w * inter_h;
    if (inter <= 0.0F) {
        return 0.0F;
    }
    const float uni = (a.area() + b.area()) - inter;
    if (uni <= kEps) {
        return 0.0F;
    }
    return inter / uni;
}

static cv::Mat letterbox_square(const cv::Mat& image, int target, LetterboxInfo& info) {
    const int src_w = image.cols;
    const int src_h = image.rows;
    if (src_w <= 0 || src_h <= 0) {
        throw std::runtime_error("invalid image size");
    }

    info.scale = std::min(static_cast<float>(target) / static_cast<float>(src_w),
                          static_cast<float>(target) / static_cast<float>(src_h));
    const int new_w = static_cast<int>(std::round(src_w * info.scale));
    const int new_h = static_cast<int>(std::round(src_h * info.scale));
    info.pad_x = (target - new_w) / 2;
    info.pad_y = (target - new_h) / 2;

    cv::Mat resized;
    cv::resize(image, resized, cv::Size(new_w, new_h), 0, 0, cv::INTER_LINEAR);
    cv::Mat canvas(target, target, CV_8UC3, cv::Scalar(114, 114, 114));
    resized.copyTo(canvas(cv::Rect(info.pad_x, info.pad_y, new_w, new_h)));
    return canvas;
}

static float unletterbox_coord(float coord, int pad, float scale, float max_val) {
    const float raw = (coord - static_cast<float>(pad)) / std::max(scale, kEps);
    return std::max(0.0F, std::min(max_val, raw));
}

static cv::Rect2f decode_box_xywh(float cx, float cy, float w, float h,
                                  const LetterboxInfo& lb, int orig_w, int orig_h) {
    const float x1_l = cx - (w / 2.0F);
    const float y1_l = cy - (h / 2.0F);
    const float x2_l = cx + (w / 2.0F);
    const float y2_l = cy + (h / 2.0F);

    const float x1 = unletterbox_coord(x1_l, lb.pad_x, lb.scale, static_cast<float>(orig_w - 1));
    const float y1 = unletterbox_coord(y1_l, lb.pad_y, lb.scale, static_cast<float>(orig_h - 1));
    const float x2 = unletterbox_coord(x2_l, lb.pad_x, lb.scale, static_cast<float>(orig_w - 1));
    const float y2 = unletterbox_coord(y2_l, lb.pad_y, lb.scale, static_cast<float>(orig_h - 1));

    const float bw = std::max(0.0F, x2 - x1);
    const float bh = std::max(0.0F, y2 - y1);
    return cv::Rect2f(x1, y1, bw, bh);
}

static cv::Rect2f decode_box_xyxy(float x1_l, float y1_l, float x2_l, float y2_l,
                                  const LetterboxInfo& lb, int orig_w, int orig_h) {
    const float x1 = unletterbox_coord(x1_l, lb.pad_x, lb.scale, static_cast<float>(orig_w - 1));
    const float y1 = unletterbox_coord(y1_l, lb.pad_y, lb.scale, static_cast<float>(orig_h - 1));
    const float x2 = unletterbox_coord(x2_l, lb.pad_x, lb.scale, static_cast<float>(orig_w - 1));
    const float y2 = unletterbox_coord(y2_l, lb.pad_y, lb.scale, static_cast<float>(orig_h - 1));

    const float bw = std::max(0.0F, x2 - x1);
    const float bh = std::max(0.0F, y2 - y1);
    return cv::Rect2f(x1, y1, bw, bh);
}

static std::vector<int> nms_indices(const std::vector<PoseCandidate>& candidates, float nms_iou) {
    std::vector<int> order(candidates.size());
    for (size_t i = 0; i < candidates.size(); ++i) {
        order[i] = static_cast<int>(i);
    }
    std::sort(order.begin(), order.end(), [&](int a, int b) {
        return candidates[a].conf > candidates[b].conf;
    });

    std::vector<int> keep;
    std::vector<bool> suppressed(candidates.size(), false);
    for (int idx : order) {
        if (suppressed[idx]) {
            continue;
        }
        keep.push_back(idx);
        for (int jdx : order) {
            if (jdx == idx || suppressed[jdx]) {
                continue;
            }
            if (iou(candidates[idx].box, candidates[jdx].box) > nms_iou) {
                suppressed[jdx] = true;
            }
        }
    }
    return keep;
}

static std::vector<uint8_t> read_binary_file(const std::string& path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file.is_open()) {
        throw std::runtime_error("failed to open model file: " + path);
    }
    const std::streamsize size = file.tellg();
    if (size <= 0) {
        throw std::runtime_error("empty model file: " + path);
    }
    file.seekg(0, std::ios::beg);
    std::vector<uint8_t> data(static_cast<size_t>(size));
    if (!file.read(reinterpret_cast<char*>(data.data()), size)) {
        throw std::runtime_error("failed to read model file: " + path);
    }
    return data;
}

static Ort::Env& ort_env() {
    static Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "cvui_cpp_inference");
    return env;
}

struct SessionOptionsBundle {
    Ort::SessionOptions options;
    std::string execution_provider = "cpu";
};

static SessionOptionsBundle build_session_options(int device_id) {
    SessionOptionsBundle bundle;
    Ort::SessionOptions& options = bundle.options;
    options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_EXTENDED);
    options.SetIntraOpNumThreads(1);
    options.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);

    if (device_id >= 0) {
        try {
            Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_CUDA(options, device_id));
            bundle.execution_provider = "cuda";
        } catch (const Ort::Exception&) {
            bundle.execution_provider = "cpu";
        }
    }

    return bundle;
}

static std::vector<float> to_chw_rgb_tensor(const cv::Mat& bgr) {
    cv::Mat rgb;
    cv::cvtColor(bgr, rgb, cv::COLOR_BGR2RGB);
    cv::Mat rgb_f32;
    rgb.convertTo(rgb_f32, CV_32F, 1.0 / 255.0);

    std::vector<cv::Mat> channels;
    cv::split(rgb_f32, channels);
    if (channels.size() != 3) {
        throw std::runtime_error("expected 3 channels after RGB conversion");
    }

    const int plane_size = rgb.rows * rgb.cols;
    std::vector<float> tensor;
    tensor.reserve(static_cast<size_t>(plane_size * 3));
    for (int c = 0; c < 3; ++c) {
        cv::Mat plane = channels[static_cast<size_t>(c)];
        if (!plane.isContinuous()) {
            plane = plane.clone();
        }
        const float* begin = plane.ptr<float>(0);
        tensor.insert(tensor.end(), begin, begin + plane_size);
    }
    return tensor;
}

class OrtModel {
public:
    OrtModel(const std::string& model_path, int device_id)
        : model_path_(model_path),
          model_data_(read_binary_file(model_path)),
          session_options_(build_session_options(device_id)),
          session_(ort_env(), model_data_.data(), model_data_.size(), session_options_.options) {
        Ort::AllocatorWithDefaultOptions allocator;

        const size_t input_count = session_.GetInputCount();
        if (input_count != 1) {
            throw std::runtime_error("expected exactly 1 input for model: " + model_path_);
        }

        const auto input_info = session_.GetInputTypeInfo(0).GetTensorTypeAndShapeInfo();
        const std::vector<int64_t> input_shape = input_info.GetShape();
        if (input_shape.size() == 4) {
            const int64_t input_h = input_shape[2];
            const int64_t input_w = input_shape[3];
            if (input_h > 0 && input_w > 0 && input_h == input_w) {
                fixed_square_input_size_ = static_cast<int>(input_h);
            }
        }

        for (size_t i = 0; i < input_count; ++i) {
            auto name = session_.GetInputNameAllocated(i, allocator);
            input_names_storage_.push_back(name.get());
        }

        const size_t output_count = session_.GetOutputCount();
        if (output_count < 1) {
            throw std::runtime_error("expected at least 1 output for model: " + model_path_);
        }
        for (size_t i = 0; i < output_count; ++i) {
            auto name = session_.GetOutputNameAllocated(i, allocator);
            output_names_storage_.push_back(name.get());
        }

        input_names_c_.reserve(input_names_storage_.size());
        for (const std::string& s : input_names_storage_) {
            input_names_c_.push_back(s.c_str());
        }
        output_names_c_.reserve(output_names_storage_.size());
        for (const std::string& s : output_names_storage_) {
            output_names_c_.push_back(s.c_str());
        }
    }

    std::vector<Ort::Value> run(const std::vector<float>& input_tensor,
                                const std::vector<int64_t>& input_shape) const {
        size_t expected = 1;
        for (int64_t dim : input_shape) {
            if (dim <= 0) {
                throw std::runtime_error("invalid input shape dim for model: " + model_path_);
            }
            expected *= static_cast<size_t>(dim);
        }
        if (expected != input_tensor.size()) {
            throw std::runtime_error("input tensor size mismatch for model: " + model_path_);
        }

        Ort::MemoryInfo memory_info = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
        Ort::Value input = Ort::Value::CreateTensor<float>(
            memory_info,
            const_cast<float*>(input_tensor.data()),
            input_tensor.size(),
            input_shape.data(),
            input_shape.size()
        );

        return session_.Run(
            Ort::RunOptions{nullptr},
            input_names_c_.data(),
            &input,
            1,
            output_names_c_.data(),
            output_names_c_.size()
        );
    }

    int fixed_square_input_size() const {
        return fixed_square_input_size_;
    }

    const std::string& execution_provider() const {
        return session_options_.execution_provider;
    }

private:
    std::string model_path_;
    std::vector<uint8_t> model_data_;
    SessionOptionsBundle session_options_;
    mutable Ort::Session session_;
    int fixed_square_input_size_ = 0;
    std::vector<std::string> input_names_storage_;
    std::vector<std::string> output_names_storage_;
    std::vector<const char*> input_names_c_;
    std::vector<const char*> output_names_c_;
};

class PoseDetector {
public:
    PoseDetector(const std::string& model_path, int device_id, int input_size, float conf_thres, float iou_thres)
        : model_(model_path, device_id),
          input_size_(input_size),
          conf_thres_(conf_thres),
          iou_thres_(iou_thres) {
        const int model_input_size = model_.fixed_square_input_size();
        if (model_input_size > 0) {
            input_size_ = model_input_size;
        }
    }

    std::vector<PoseCandidate> infer(const cv::Mat& bgr) const {
        if (bgr.empty()) {
            return {};
        }

        LetterboxInfo lb{};
        const cv::Mat input = letterbox_square(bgr, input_size_, lb);
        const std::vector<float> tensor = to_chw_rgb_tensor(input);
        const std::vector<int64_t> input_shape = {1, 3, input_size_, input_size_};

        std::vector<Ort::Value> outputs = model_.run(tensor, input_shape);
        if (outputs.empty()) {
            return {};
        }

        const Ort::Value& out = outputs[0];
        if (!out.IsTensor()) {
            throw std::runtime_error("pose output is not a tensor");
        }
        const auto shape_info = out.GetTensorTypeAndShapeInfo();
        if (shape_info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
            throw std::runtime_error("pose output tensor is not float32");
        }
        const std::vector<int64_t> shape = shape_info.GetShape();
        const size_t total_values = shape_info.GetElementCount();
        if (total_values == 0) {
            return {};
        }
        const float* data = out.GetTensorData<float>();

        // Ultralytics ONNX export may produce either:
        // 1) raw pose head tensors (e.g. [1, 56, N] / [1, N, 56])
        // 2) postprocessed detections (e.g. [1, 300, 57] => xyxy, score, class, kpts...)
        if (shape.size() == 3 && shape[0] == 1 && shape[2] >= (6 + kPoseKeypointCount * 3)) {
            const int predictions = static_cast<int>(shape[1]);
            const int stride = static_cast<int>(shape[2]);
            std::vector<PoseCandidate> filtered;
            filtered.reserve(static_cast<size_t>(predictions));

            for (int i = 0; i < predictions; ++i) {
                const float* row = data + (static_cast<size_t>(i) * static_cast<size_t>(stride));
                const float conf = row[4];
                if (conf < conf_thres_) {
                    continue;
                }

                PoseCandidate cand;
                cand.conf = conf;
                cand.box = decode_box_xyxy(row[0], row[1], row[2], row[3], lb, bgr.cols, bgr.rows);
                if (cand.box.width < 1.0F || cand.box.height < 1.0F) {
                    continue;
                }

                for (int k = 0; k < kPoseKeypointCount; ++k) {
                    const int base = 6 + (k * 3);
                    if ((base + 2) >= stride) {
                        break;
                    }
                    const float kx_l = row[base + 0];
                    const float ky_l = row[base + 1];
                    const float ks = row[base + 2];
                    cand.keypoints[static_cast<size_t>(k)] = cv::Point3f(
                        unletterbox_coord(kx_l, lb.pad_x, lb.scale, static_cast<float>(bgr.cols - 1)),
                        unletterbox_coord(ky_l, lb.pad_y, lb.scale, static_cast<float>(bgr.rows - 1)),
                        ks
                    );
                }

                filtered.push_back(cand);
            }

            return filtered;
        }

        int channels = 0;
        int predictions = 0;
        bool channel_first = true;

        if (shape.size() >= 3) {
            const int s1 = static_cast<int>(shape[shape.size() - 2]);
            const int s2 = static_cast<int>(shape[shape.size() - 1]);
            if (s1 >= kPoseMinChannels) {
                channels = s1;
                predictions = s2;
                channel_first = true;
            } else if (s2 >= kPoseMinChannels) {
                channels = s2;
                predictions = s1;
                channel_first = false;
            }
        } else if (shape.size() == 2) {
            const int s0 = static_cast<int>(shape[0]);
            const int s1 = static_cast<int>(shape[1]);
            if (s0 >= kPoseMinChannels) {
                channels = s0;
                predictions = s1;
                channel_first = true;
            } else if (s1 >= kPoseMinChannels) {
                channels = s1;
                predictions = s0;
                channel_first = false;
            }
        }

        if (channels < kPoseMinChannels || predictions <= 0) {
            throw std::runtime_error("unable to infer pose output layout");
        }
        if (static_cast<size_t>(channels * predictions) > total_values) {
            throw std::runtime_error("pose output tensor size/layout mismatch");
        }

        auto value_at = [&](int c, int n) -> float {
            if (channel_first) {
                return data[(c * predictions) + n];
            }
            return data[(n * channels) + c];
        };

        std::vector<PoseCandidate> raw;
        raw.reserve(static_cast<size_t>(predictions));

        for (int i = 0; i < predictions; ++i) {
            const float conf = value_at(4, i);
            if (conf < conf_thres_) {
                continue;
            }

            const float cx = value_at(0, i);
            const float cy = value_at(1, i);
            const float w = value_at(2, i);
            const float h = value_at(3, i);

            PoseCandidate cand;
            cand.conf = conf;
            cand.box = decode_box_xywh(cx, cy, w, h, lb, bgr.cols, bgr.rows);
            if (cand.box.width < 1.0F || cand.box.height < 1.0F) {
                continue;
            }

            for (int k = 0; k < kPoseKeypointCount; ++k) {
                const int base = 5 + (k * 3);
                const float kx_l = value_at(base + 0, i);
                const float ky_l = value_at(base + 1, i);
                const float ks = value_at(base + 2, i);
                cand.keypoints[static_cast<size_t>(k)] = cv::Point3f(
                    unletterbox_coord(kx_l, lb.pad_x, lb.scale, static_cast<float>(bgr.cols - 1)),
                    unletterbox_coord(ky_l, lb.pad_y, lb.scale, static_cast<float>(bgr.rows - 1)),
                    ks
                );
            }

            raw.push_back(cand);
        }

        const std::vector<int> keep = nms_indices(raw, iou_thres_);
        std::vector<PoseCandidate> filtered;
        filtered.reserve(keep.size());
        for (int idx : keep) {
            filtered.push_back(raw[static_cast<size_t>(idx)]);
        }
        return filtered;
    }

    const std::string& execution_provider() const {
        return model_.execution_provider();
    }

private:
    OrtModel model_;
    int input_size_;
    float conf_thres_;
    float iou_thres_;
};

class DressCodeClassifier {
public:
    DressCodeClassifier(const std::string& model_path, const std::string& names_path, int device_id,
                        int input_size, float min_conf)
        : model_(model_path, device_id),
          input_size_(input_size),
          min_conf_(min_conf),
          class_names_(load_names(names_path)) {
        const int model_input_size = model_.fixed_square_input_size();
        if (model_input_size > 0) {
            input_size_ = model_input_size;
        }
    }

    std::pair<std::string, float> classify(const cv::Mat& crop) const {
        if (crop.empty()) {
            return {"", 0.0F};
        }

        cv::Mat resized;
        cv::resize(crop, resized, cv::Size(input_size_, input_size_), 0, 0, cv::INTER_LINEAR);
        const std::vector<float> tensor = to_chw_rgb_tensor(resized);
        const std::vector<int64_t> input_shape = {1, 3, input_size_, input_size_};

        std::vector<Ort::Value> outputs = model_.run(tensor, input_shape);
        if (outputs.empty() || !outputs[0].IsTensor()) {
            return {"", 0.0F};
        }

        const auto out_info = outputs[0].GetTensorTypeAndShapeInfo();
        if (out_info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
            throw std::runtime_error("classifier output tensor is not float32");
        }
        const size_t count = out_info.GetElementCount();
        if (count == 0) {
            return {"", 0.0F};
        }

        const float* out = outputs[0].GetTensorData<float>();
        std::vector<float> logits(count);
        for (size_t i = 0; i < count; ++i) {
            logits[i] = out[i];
        }

        const float max_logit = *std::max_element(logits.begin(), logits.end());
        float denom = 0.0F;
        for (float& v : logits) {
            v = std::exp(v - max_logit);
            denom += v;
        }
        if (denom <= kEps) {
            return {"", 0.0F};
        }
        for (float& v : logits) {
            v /= denom;
        }

        size_t best_idx = 0;
        float best_conf = logits[0];
        for (size_t i = 1; i < logits.size(); ++i) {
            if (logits[i] > best_conf) {
                best_conf = logits[i];
                best_idx = i;
            }
        }

        if (best_conf < min_conf_) {
            return {"", best_conf};
        }

        std::string label = "class_" + std::to_string(best_idx);
        if (best_idx < class_names_.size() && !class_names_[best_idx].empty()) {
            label = class_names_[best_idx];
        }
        return {label, best_conf};
    }

    const std::string& execution_provider() const {
        return model_.execution_provider();
    }

private:
    static std::vector<std::string> load_names(const std::string& path) {
        std::vector<std::string> names;
        if (path.empty()) {
            return names;
        }
        std::ifstream file(path);
        if (!file.is_open()) {
            return names;
        }
        std::string line;
        while (std::getline(file, line)) {
            line = trim(line);
            if (!line.empty()) {
                names.push_back(line);
            }
        }
        return names;
    }

    OrtModel model_;
    int input_size_;
    float min_conf_;
    std::vector<std::string> class_names_;
};

class ByteTrackAdapter {
public:
    ByteTrackAdapter(const TrackerConfig& config, int frame_rate = 30)
        : tracker_(frame_rate,
                   config.track_buffer,
                   config.track_high_thresh,
                   config.new_track_thresh,
                   config.match_thresh),
          assignment_iou_thresh_(std::max(0.3F, std::min(config.match_thresh, 0.7F))) {}

    std::vector<int> update(const std::vector<PoseCandidate>& detections) {
        std::vector<int> detection_track_ids(detections.size(), -1);
        if (detections.empty()) {
            tracker_.update({});
            return detection_track_ids;
        }

        std::vector<byte_track::Object> objects;
        objects.reserve(detections.size());
        for (const PoseCandidate& det : detections) {
            objects.emplace_back(
                byte_track::Rect<float>(det.box.x, det.box.y, det.box.width, det.box.height),
                0,
                det.conf
            );
        }

        const auto tracks = tracker_.update(objects);
        std::vector<bool> track_used(tracks.size(), false);
        std::vector<bool> det_used(detections.size(), false);

        struct PairMatch {
            float score;
            int track_index;
            int det_index;
        };
        std::vector<PairMatch> candidates;
        candidates.reserve(tracks.size() * detections.size());
        for (int ti = 0; ti < static_cast<int>(tracks.size()); ++ti) {
            const auto& rect = tracks[static_cast<size_t>(ti)]->getRect();
            const cv::Rect2f track_box(rect.x(), rect.y(), rect.width(), rect.height());
            for (int di = 0; di < static_cast<int>(detections.size()); ++di) {
                const float score = iou(track_box, detections[static_cast<size_t>(di)].box);
                if (score >= assignment_iou_thresh_) {
                    candidates.push_back({score, ti, di});
                }
            }
        }
        std::sort(candidates.begin(), candidates.end(), [](const PairMatch& a, const PairMatch& b) {
            return a.score > b.score;
        });

        for (const PairMatch& m : candidates) {
            if (track_used[static_cast<size_t>(m.track_index)] || det_used[static_cast<size_t>(m.det_index)]) {
                continue;
            }
            detection_track_ids[static_cast<size_t>(m.det_index)] =
                static_cast<int>(tracks[static_cast<size_t>(m.track_index)]->getTrackId());
            track_used[static_cast<size_t>(m.track_index)] = true;
            det_used[static_cast<size_t>(m.det_index)] = true;
        }

        return detection_track_ids;
    }

private:
    byte_track::BYTETracker tracker_;
    float assignment_iou_thresh_;
};

static bool crop_lower_body(const cv::Mat& frame, const PoseCandidate& det, cv::Rect& lower_box) {
    if (det.box.height < static_cast<float>(kMinPersonHeightPx)) {
        return false;
    }

    const cv::Point3f hip_l = det.keypoints[11];
    const cv::Point3f hip_r = det.keypoints[12];
    if (hip_l.y <= 0.0F || hip_r.y <= 0.0F) {
        return false;
    }

    const float x1 = det.box.x;
    const float x2 = det.box.x + det.box.width;
    const float y2 = det.box.y + det.box.height;
    const float hip_y = (hip_l.y + hip_r.y) / 2.0F;
    if (hip_y >= y2) {
        return false;
    }

    const int nx1 = std::max(0, static_cast<int>(std::floor(x1)));
    const int ny1 = std::max(0, static_cast<int>(std::floor(hip_y)));
    const int nx2 = std::min(frame.cols, static_cast<int>(std::ceil(x2)));
    const int ny2 = std::min(frame.rows, static_cast<int>(std::ceil(y2)));
    if (nx2 <= nx1 || ny2 <= ny1) {
        return false;
    }
    lower_box = cv::Rect(nx1, ny1, nx2 - nx1, ny2 - ny1);
    return lower_box.width >= kMinCropDim && lower_box.height >= kMinCropDim;
}

static py::list to_bbox_list(const cv::Rect2f& box) {
    py::list bbox;
    bbox.append(box.x);
    bbox.append(box.y);
    bbox.append(box.x + box.width);
    bbox.append(box.y + box.height);
    return bbox;
}

static py::list to_bbox_list_int(const cv::Rect& box) {
    py::list bbox;
    bbox.append(box.x);
    bbox.append(box.y);
    bbox.append(box.x + box.width);
    bbox.append(box.y + box.height);
    return bbox;
}

}  // namespace

struct InferenceCore::Impl {
    Impl(std::string pose_model_path,
         std::string classifier_model_path,
         std::string class_names_path,
         std::string tracker_config_path,
         int device_id,
         int pose_imgsz,
         int cls_imgsz,
         float det_conf,
         float det_iou,
         float cls_conf_min)
        : pose_model_path(std::move(pose_model_path)),
          classifier_model_path(std::move(classifier_model_path)),
          class_names_path(std::move(class_names_path)),
          tracker_config_path(std::move(tracker_config_path)),
          device_id(device_id),
          pose_imgsz(pose_imgsz),
          cls_imgsz(cls_imgsz),
          det_conf(det_conf),
          det_iou(det_iou),
          cls_conf_min(cls_conf_min),
          tracker_cfg(load_tracker_config(this->tracker_config_path)),
          pose_detector(this->pose_model_path, device_id, pose_imgsz, det_conf, det_iou),
          classifier(this->classifier_model_path, this->class_names_path, device_id, cls_imgsz, cls_conf_min),
          tracker(tracker_cfg) {}

    std::string pose_model_path;
    std::string classifier_model_path;
    std::string class_names_path;
    std::string tracker_config_path;
    int device_id;
    int pose_imgsz;
    int cls_imgsz;
    float det_conf;
    float det_iou;
    float cls_conf_min;

    TrackerConfig tracker_cfg;
    PoseDetector pose_detector;
    DressCodeClassifier classifier;
    ByteTrackAdapter tracker;
};

InferenceCore::InferenceCore(std::string pose_model_path,
                             std::string classifier_model_path,
                             std::string class_names_path,
                             std::string tracker_config_path,
                             int device_id,
                             int pose_imgsz,
                             int cls_imgsz,
                             float det_conf,
                             float det_iou,
                             float cls_conf_min)
    : impl_(std::make_unique<Impl>(std::move(pose_model_path),
                                   std::move(classifier_model_path),
                                   std::move(class_names_path),
                                   std::move(tracker_config_path),
                                   device_id,
                                   pose_imgsz,
                                   cls_imgsz,
                                   det_conf,
                                   det_iou,
                                   cls_conf_min)) {}

InferenceCore::~InferenceCore() = default;

py::dict InferenceCore::run_frame(const py::array& image, int frame_index, bool skip_classification) {
    py::array contiguous = py::array::ensure(
        image,
        py::array::c_style | py::array::forcecast
    );
    if (!contiguous) {
        throw std::runtime_error("image must be convertible to contiguous uint8 array");
    }

    auto info = contiguous.request();
    if (info.ndim != 3) {
        throw std::runtime_error("image must be HxWxC");
    }
    if (info.format != py::format_descriptor<unsigned char>::format()) {
        throw std::runtime_error("image dtype must be uint8");
    }

    const int height = static_cast<int>(info.shape[0]);
    const int width = static_cast<int>(info.shape[1]);
    const int channels = static_cast<int>(info.shape[2]);
    if (height <= 0 || width <= 0) {
        throw std::runtime_error("image dimensions must be positive");
    }
    if (channels < 3) {
        throw std::runtime_error("image must have at least 3 channels");
    }

    cv::Mat view(height, width, CV_8UC(channels), info.ptr);
    cv::Mat bgr;
    if (channels == 3) {
        bgr = view.clone();
    } else if (channels == 4) {
        cv::cvtColor(view, bgr, cv::COLOR_BGRA2BGR);
    } else {
        std::vector<cv::Mat> merged_channels(3);
        for (int c = 0; c < 3; ++c) {
            cv::extractChannel(view, merged_channels[static_cast<size_t>(c)], c);
        }
        cv::merge(merged_channels, bgr);
    }

    const std::vector<PoseCandidate> pose = impl_->pose_detector.infer(bgr);
    const std::vector<int> track_ids = impl_->tracker.update(pose);

    py::list detections;
    py::dict track_updates;
    for (size_t i = 0; i < pose.size(); ++i) {
        const PoseCandidate& det = pose[i];
        const int track_id = (i < track_ids.size()) ? track_ids[i] : -1;

        py::dict entry;
        try {
            if (track_id > 0) {
                entry["track_id"] = py::int_(track_id);
            } else {
                entry["track_id"] = py::none();
            }
        } catch (const py::error_already_set& e) {
            throw std::runtime_error(
                "failed to set track_id for detection " + std::to_string(i) +
                " on frame " + std::to_string(frame_index) +
                " (track_id=" + std::to_string(track_id) + "): " + e.what()
            );
        }
        try {
            entry["person_bbox"] = to_bbox_list(det.box);
            entry["violation"] = false;
        } catch (const py::error_already_set& e) {
            throw std::runtime_error(
                "failed to set bbox/violation for detection " + std::to_string(i) +
                " on frame " + std::to_string(frame_index) + ": " + e.what()
            );
        }

        py::object label_obj = py::none();
        py::object conf_obj = py::none();
        py::object lower_obj = py::none();

        if (!skip_classification) {
            cv::Rect lower_box;
            if (crop_lower_body(bgr, det, lower_box)) {
                const cv::Mat crop = bgr(lower_box).clone();
                const auto [label, conf] = impl_->classifier.classify(crop);
                if (!label.empty()) {
                    label_obj = py::str(label);
                    conf_obj = py::float_(std::round(conf * 1000.0F) / 1000.0F);
                    lower_obj = to_bbox_list_int(lower_box);

                    if (track_id > 0) {
                        try {
                            py::dict upd;
                            upd["label"] = label_obj;
                            upd["confidence"] = conf_obj;
                            upd["lower_bbox"] = lower_obj;
                            upd["last_classified_frame"] = frame_index;
                            track_updates[py::int_(track_id)] = upd;
                        } catch (const py::error_already_set& e) {
                            throw std::runtime_error(
                                "failed to update track_state for detection " + std::to_string(i) +
                                " on frame " + std::to_string(frame_index) +
                                " (track_id=" + std::to_string(track_id) + "): " + e.what()
                            );
                        }
                    }
                }
            }
        }

        try {
            entry["label"] = label_obj;
            entry["confidence"] = conf_obj;
            entry["lower_bbox"] = lower_obj;
            detections.append(entry);
        } catch (const py::error_already_set& e) {
            throw std::runtime_error(
                "failed to finalize detection " + std::to_string(i) +
                " on frame " + std::to_string(frame_index) +
                " (track_id=" + std::to_string(track_id) + "): " + e.what()
            );
        }
    }

    py::dict result;
    result["detections"] = detections;
    result["people_count"] = static_cast<int>(detections.size());
    result["track_state_updates"] = track_updates;
    result["frame_index"] = frame_index;
    result["backend"] = "cpp_onnxruntime";
    return result;
}

py::dict InferenceCore::health() const {
    py::dict status;
    status["backend"] = "cpp_onnxruntime";
    status["pose_model_path"] = impl_->pose_model_path;
    status["classifier_model_path"] = impl_->classifier_model_path;
    status["class_names_path"] = impl_->class_names_path;
    status["tracker_config_path"] = impl_->tracker_config_path;
    status["device_id"] = impl_->device_id;
    status["pose_imgsz"] = impl_->pose_imgsz;
    status["cls_imgsz"] = impl_->cls_imgsz;
    status["det_conf"] = impl_->det_conf;
    status["det_iou"] = impl_->det_iou;
    status["cls_conf_min"] = impl_->cls_conf_min;
    status["tracker_track_high_thresh"] = impl_->tracker_cfg.track_high_thresh;
    status["tracker_new_track_thresh"] = impl_->tracker_cfg.new_track_thresh;
    status["tracker_match_thresh"] = impl_->tracker_cfg.match_thresh;
    status["tracker_buffer"] = impl_->tracker_cfg.track_buffer;
    status["pose_execution_provider"] = impl_->pose_detector.execution_provider();
    status["classifier_execution_provider"] = impl_->classifier.execution_provider();
    return status;
}
