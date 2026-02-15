#include "inference_core.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <opencv2/core.hpp>
#include <opencv2/dnn.hpp>
#include <opencv2/imgproc.hpp>

namespace {

constexpr int kPoseKeypointCount = 17;
constexpr int kPoseMinChannels = 5 + (kPoseKeypointCount * 3);
constexpr float kEps = 1e-6F;
constexpr int kMinPersonHeightPx = 160;
constexpr int kMinCropDim = 32;

struct TrackerConfig {
    float match_thresh = 0.3F;
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
        } else if (key == "track_buffer") {
            try {
                cfg.track_buffer = std::stoi(value);
            } catch (...) {
            }
        }
    }
    if (cfg.match_thresh <= 0.0F || cfg.match_thresh > 1.0F) {
        cfg.match_thresh = 0.3F;
    }
    if (cfg.track_buffer < 1) {
        cfg.track_buffer = 30;
    }
    return cfg;
}

static cv::dnn::Net load_onnx_net(const std::string& model_path, int device_id) {
    cv::dnn::Net net = cv::dnn::readNetFromONNX(model_path);
    if (net.empty()) {
        throw std::runtime_error("failed to load ONNX model: " + model_path);
    }

    if (device_id >= 0) {
        try {
            net.setPreferableBackend(cv::dnn::DNN_BACKEND_CUDA);
            net.setPreferableTarget(cv::dnn::DNN_TARGET_CUDA);
            return net;
        } catch (...) {
            // Fall through to CPU.
        }
    }
    net.setPreferableBackend(cv::dnn::DNN_BACKEND_OPENCV);
    net.setPreferableTarget(cv::dnn::DNN_TARGET_CPU);
    return net;
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

class PoseDetector {
public:
    PoseDetector(const std::string& model_path, int device_id, int input_size, float conf, float iou_thres)
        : net_(load_onnx_net(model_path, device_id)),
          input_size_(input_size),
          conf_thres_(conf),
          iou_thres_(iou_thres) {}

    std::vector<PoseCandidate> infer(const cv::Mat& bgr) {
        if (bgr.empty()) {
            return {};
        }

        LetterboxInfo lb{};
        cv::Mat input = letterbox_square(bgr, input_size_, lb);
        cv::Mat blob = cv::dnn::blobFromImage(input, 1.0 / 255.0, cv::Size(input_size_, input_size_),
                                              cv::Scalar(), true, false, CV_32F);
        net_.setInput(blob);
        cv::Mat output = net_.forward();

        int channels = 0;
        int predictions = 0;
        bool channel_first = true;  // [1, C, N] or [C, N]
        bool rank3 = false;

        if (output.dims == 3) {
            rank3 = true;
            const int s1 = output.size[1];
            const int s2 = output.size[2];
            if (s1 >= kPoseMinChannels && s2 > s1) {
                channels = s1;
                predictions = s2;
                channel_first = true;   // [1, C, N]
            } else if (s2 >= kPoseMinChannels && s1 > s2) {
                channels = s2;
                predictions = s1;
                channel_first = false;  // [1, N, C]
            } else if (s1 >= kPoseMinChannels) {
                channels = s1;
                predictions = s2;
                channel_first = true;
            } else {
                channels = s2;
                predictions = s1;
                channel_first = false;
            }
        } else if (output.dims == 2) {
            if (output.size[0] > output.size[1]) {
                predictions = output.size[0];
                channels = output.size[1];
                channel_first = false;  // [N, C]
            } else {
                channels = output.size[0];
                predictions = output.size[1];
                channel_first = true;  // [C, N]
            }
        } else {
            throw std::runtime_error("unexpected pose output dims");
        }

        if (channels < kPoseMinChannels) {
            throw std::runtime_error("pose output has insufficient channels");
        }

        const float* data = reinterpret_cast<float*>(output.data);
        auto value_at = [&](int c, int n) -> float {
            if (rank3) {
                if (channel_first) {
                    return data[(c * predictions) + n];            // [1, C, N]
                }
                return data[(n * channels) + c];                   // [1, N, C]
            }
            if (channel_first) {                                    // [C, N]
                return data[(c * predictions) + n];
            }
            return data[(n * channels) + c];                        // [N, C]
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
                const float kx = unletterbox_coord(kx_l, lb.pad_x, lb.scale, static_cast<float>(bgr.cols - 1));
                const float ky = unletterbox_coord(ky_l, lb.pad_y, lb.scale, static_cast<float>(bgr.rows - 1));
                cand.keypoints[k] = cv::Point3f(kx, ky, ks);
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

private:
    cv::dnn::Net net_;
    int input_size_;
    float conf_thres_;
    float iou_thres_;
};

class DressCodeClassifier {
public:
    DressCodeClassifier(const std::string& model_path, const std::string& names_path, int device_id,
                        int input_size, float min_conf)
        : net_(load_onnx_net(model_path, device_id)),
          input_size_(input_size),
          min_conf_(min_conf),
          class_names_(load_names(names_path)) {}

    std::pair<std::string, float> classify(const cv::Mat& crop) const {
        if (crop.empty()) {
            return {"", 0.0F};
        }
        cv::Mat resized;
        cv::resize(crop, resized, cv::Size(input_size_, input_size_), 0, 0, cv::INTER_LINEAR);

        cv::Mat blob = cv::dnn::blobFromImage(resized, 1.0 / 255.0, cv::Size(input_size_, input_size_),
                                              cv::Scalar(), true, false, CV_32F);
        net_.setInput(blob);
        cv::Mat out = net_.forward();

        const int count = static_cast<int>(out.total());
        if (count <= 0) {
            return {"", 0.0F};
        }

        const float* data = reinterpret_cast<float*>(out.data);
        std::vector<float> logits(static_cast<size_t>(count));
        for (int i = 0; i < count; ++i) {
            logits[static_cast<size_t>(i)] = data[i];
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

        int best_idx = 0;
        float best_conf = logits[0];
        for (int i = 1; i < count; ++i) {
            if (logits[static_cast<size_t>(i)] > best_conf) {
                best_conf = logits[static_cast<size_t>(i)];
                best_idx = i;
            }
        }

        if (best_conf < min_conf_) {
            return {"", best_conf};
        }

        std::string label = "class_" + std::to_string(best_idx);
        if (best_idx >= 0 && best_idx < static_cast<int>(class_names_.size()) &&
            !class_names_[static_cast<size_t>(best_idx)].empty()) {
            label = class_names_[static_cast<size_t>(best_idx)];
        }
        return {label, best_conf};
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

    mutable cv::dnn::Net net_;
    int input_size_;
    float min_conf_;
    std::vector<std::string> class_names_;
};

class IoUTracker {
public:
    IoUTracker(float match_thresh, int max_missed)
        : match_thresh_(match_thresh), max_missed_(max_missed) {}

    std::vector<int> update(const std::vector<PoseCandidate>& detections) {
        std::vector<int> det_ids(detections.size(), -1);
        if (detections.empty()) {
            for (Track& t : tracks_) {
                t.missed += 1;
            }
            prune_tracks();
            return det_ids;
        }

        std::vector<bool> track_used(tracks_.size(), false);
        std::vector<bool> det_used(detections.size(), false);

        struct PairMatch {
            float score;
            int track_index;
            int det_index;
        };
        std::vector<PairMatch> candidates;
        candidates.reserve(tracks_.size() * detections.size());
        for (int ti = 0; ti < static_cast<int>(tracks_.size()); ++ti) {
            for (int di = 0; di < static_cast<int>(detections.size()); ++di) {
                const float score = iou(tracks_[static_cast<size_t>(ti)].box, detections[static_cast<size_t>(di)].box);
                if (score >= match_thresh_) {
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
            Track& track = tracks_[static_cast<size_t>(m.track_index)];
            track.box = detections[static_cast<size_t>(m.det_index)].box;
            track.missed = 0;
            det_ids[static_cast<size_t>(m.det_index)] = track.id;
            track_used[static_cast<size_t>(m.track_index)] = true;
            det_used[static_cast<size_t>(m.det_index)] = true;
        }

        for (size_t di = 0; di < detections.size(); ++di) {
            if (det_used[di]) {
                continue;
            }
            Track track;
            track.id = next_id_++;
            track.box = detections[di].box;
            track.missed = 0;
            tracks_.push_back(track);
            det_ids[di] = track.id;
        }

        for (size_t ti = 0; ti < tracks_.size(); ++ti) {
            if (!track_used[ti]) {
                tracks_[ti].missed += 1;
            }
        }

        prune_tracks();
        return det_ids;
    }

private:
    struct Track {
        int id = -1;
        cv::Rect2f box;
        int missed = 0;
    };

    void prune_tracks() {
        tracks_.erase(
            std::remove_if(tracks_.begin(), tracks_.end(), [&](const Track& t) {
                return t.missed > max_missed_;
            }),
            tracks_.end()
        );
    }

    float match_thresh_;
    int max_missed_;
    int next_id_ = 1;
    std::vector<Track> tracks_;
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
    const float y1 = det.box.y;
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
          tracker(tracker_cfg.match_thresh, tracker_cfg.track_buffer) {}

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
    IoUTracker tracker;
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

py::dict InferenceCore::run_frame(const py::array& image, int frame_index, bool skip_classification) {
    auto info = image.request();
    if (info.ndim != 3) {
        throw std::runtime_error("image must be HxWxC");
    }
    if (info.format != py::format_descriptor<unsigned char>::format()) {
        throw std::runtime_error("image dtype must be uint8");
    }

    const int height = static_cast<int>(info.shape[0]);
    const int width = static_cast<int>(info.shape[1]);
    const int channels = static_cast<int>(info.shape[2]);
    if (channels < 3) {
        throw std::runtime_error("image must have at least 3 channels");
    }

    cv::Mat view(height, width, CV_8UC(channels), info.ptr, static_cast<size_t>(info.strides[0]));
    cv::Mat bgr;
    if (channels == 3) {
        bgr = view;
    } else if (channels == 4) {
        cv::cvtColor(view, bgr, cv::COLOR_BGRA2BGR);
    } else {
        cv::Mat merged_channels[3];
        for (int c = 0; c < 3; ++c) {
            cv::extractChannel(view, merged_channels[c], c);
        }
        cv::merge(merged_channels, 3, bgr);
    }

    const std::vector<PoseCandidate> pose = impl_->pose_detector.infer(bgr);
    const std::vector<int> track_ids = impl_->tracker.update(pose);

    py::list detections;
    py::dict track_updates;
    for (size_t i = 0; i < pose.size(); ++i) {
        const PoseCandidate& det = pose[i];
        const int track_id = (i < track_ids.size()) ? track_ids[i] : -1;

        py::dict entry;
        entry["track_id"] = (track_id > 0) ? py::int_(track_id) : py::none();
        entry["person_bbox"] = to_bbox_list(det.box);
        entry["violation"] = false;

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
                        py::dict upd;
                        upd["label"] = label_obj;
                        upd["confidence"] = conf_obj;
                        upd["lower_bbox"] = lower_obj;
                        upd["last_classified_frame"] = frame_index;
                        track_updates[py::int_(track_id)] = upd;
                    }
                }
            }
        }

        entry["label"] = label_obj;
        entry["confidence"] = conf_obj;
        entry["lower_bbox"] = lower_obj;
        detections.append(entry);
    }

    py::dict result;
    result["detections"] = detections;
    result["people_count"] = static_cast<int>(detections.size());
    result["track_state_updates"] = track_updates;
    result["frame_index"] = frame_index;
    result["backend"] = "cpp_opencv_dnn";
    return result;
}

py::dict InferenceCore::health() const {
    py::dict status;
    status["backend"] = "cpp_opencv_dnn";
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
    status["tracker_match_thresh"] = impl_->tracker_cfg.match_thresh;
    status["tracker_buffer"] = impl_->tracker_cfg.track_buffer;
    return status;
}
