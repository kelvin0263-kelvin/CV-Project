cmake_minimum_required(VERSION 3.18)
project(cvui_cpp_inference LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Python COMPONENTS Interpreter Development REQUIRED)
find_package(pybind11 CONFIG REQUIRED)
find_package(OpenCV REQUIRED COMPONENTS core imgproc dnn)

pybind11_add_module(
    cvui_cpp_inference
    src/module.cpp
    src/inference_core.cpp
)

target_include_directories(cvui_cpp_inference PRIVATE include)
target_link_libraries(cvui_cpp_inference PRIVATE ${OpenCV_LIBS})
