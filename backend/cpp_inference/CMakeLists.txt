cmake_minimum_required(VERSION 3.18)
project(cvui_cpp_inference LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(ONNXRUNTIME_ROOT "" CACHE PATH "Path to a prebuilt ONNX Runtime package root")

find_package(Python COMPONENTS Interpreter Development REQUIRED)
find_package(pybind11 CONFIG REQUIRED)
find_package(OpenCV REQUIRED COMPONENTS core imgproc)
find_package(Eigen3 CONFIG REQUIRED)

if(WIN32 AND Python_LIBRARY)
    function(_force_python_import_library target_name)
        if(NOT TARGET "${target_name}")
            return()
        endif()

        get_target_property(_python_target_type "${target_name}" TYPE)
        if(_python_target_type STREQUAL "INTERFACE_LIBRARY")
            return()
        endif()

        # CMake can pick an unrelated debug import library from vcpkg on Windows.
        set_target_properties("${target_name}" PROPERTIES
            IMPORTED_IMPLIB "${Python_LIBRARY}"
            IMPORTED_IMPLIB_DEBUG "${Python_LIBRARY}"
            IMPORTED_IMPLIB_RELEASE "${Python_LIBRARY}"
            IMPORTED_IMPLIB_RELWITHDEBINFO "${Python_LIBRARY}"
            IMPORTED_IMPLIB_MINSIZEREL "${Python_LIBRARY}"
        )

        if(DEFINED Python_RUNTIME_LIBRARY AND EXISTS "${Python_RUNTIME_LIBRARY}")
            set_target_properties("${target_name}" PROPERTIES
                IMPORTED_LOCATION "${Python_RUNTIME_LIBRARY}"
                IMPORTED_LOCATION_DEBUG "${Python_RUNTIME_LIBRARY}"
                IMPORTED_LOCATION_RELEASE "${Python_RUNTIME_LIBRARY}"
                IMPORTED_LOCATION_RELWITHDEBINFO "${Python_RUNTIME_LIBRARY}"
                IMPORTED_LOCATION_MINSIZEREL "${Python_RUNTIME_LIBRARY}"
            )
        endif()
    endfunction()

    _force_python_import_library(Python::Module)
    _force_python_import_library(Python::Python)
endif()

if(ONNXRUNTIME_ROOT)
    set(ONNXRUNTIME_INCLUDE_DIR "")
    set(ONNXRUNTIME_LIBRARY "")

    if(EXISTS "${ONNXRUNTIME_ROOT}/include/onnxruntime_cxx_api.h")
        set(ONNXRUNTIME_INCLUDE_DIR "${ONNXRUNTIME_ROOT}/include")
    elseif(EXISTS "${ONNXRUNTIME_ROOT}/include/onnxruntime/core/session/onnxruntime_cxx_api.h")
        set(ONNXRUNTIME_INCLUDE_DIR "${ONNXRUNTIME_ROOT}/include/onnxruntime/core/session")
    elseif(EXISTS "${ONNXRUNTIME_ROOT}/build/native/include/onnxruntime_cxx_api.h")
        set(ONNXRUNTIME_INCLUDE_DIR "${ONNXRUNTIME_ROOT}/build/native/include")
    elseif(EXISTS "${ONNXRUNTIME_ROOT}/build/native/include/onnxruntime/core/session/onnxruntime_cxx_api.h")
        set(ONNXRUNTIME_INCLUDE_DIR "${ONNXRUNTIME_ROOT}/build/native/include/onnxruntime/core/session")
    endif()

    if(EXISTS "${ONNXRUNTIME_ROOT}/lib/onnxruntime.lib")
        set(ONNXRUNTIME_LIBRARY "${ONNXRUNTIME_ROOT}/lib/onnxruntime.lib")
    elseif(EXISTS "${ONNXRUNTIME_ROOT}/lib64/onnxruntime.lib")
        set(ONNXRUNTIME_LIBRARY "${ONNXRUNTIME_ROOT}/lib64/onnxruntime.lib")
    elseif(EXISTS "${ONNXRUNTIME_ROOT}/runtimes/win-x64/native/onnxruntime.lib")
        set(ONNXRUNTIME_LIBRARY "${ONNXRUNTIME_ROOT}/runtimes/win-x64/native/onnxruntime.lib")
    elseif(EXISTS "${ONNXRUNTIME_ROOT}/build/native/onnxruntime.lib")
        set(ONNXRUNTIME_LIBRARY "${ONNXRUNTIME_ROOT}/build/native/onnxruntime.lib")
    endif()

    if(NOT ONNXRUNTIME_INCLUDE_DIR OR NOT ONNXRUNTIME_LIBRARY)
        message(FATAL_ERROR "Failed to locate ONNX Runtime headers/library under ONNXRUNTIME_ROOT=${ONNXRUNTIME_ROOT}")
    endif()

    message(STATUS "Using manual ONNX Runtime include dir: ${ONNXRUNTIME_INCLUDE_DIR}")
    message(STATUS "Using manual ONNX Runtime library: ${ONNXRUNTIME_LIBRARY}")

    add_library(onnxruntime_manual UNKNOWN IMPORTED)
    set_target_properties(onnxruntime_manual PROPERTIES
        IMPORTED_LOCATION "${ONNXRUNTIME_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${ONNXRUNTIME_INCLUDE_DIR}"
    )
    set(ONNXRUNTIME_TARGET onnxruntime_manual)
else()
    find_package(onnxruntime CONFIG REQUIRED)

    if(TARGET onnxruntime::onnxruntime)
        set(ONNXRUNTIME_TARGET onnxruntime::onnxruntime)
    elseif(TARGET onnxruntime)
        set(ONNXRUNTIME_TARGET onnxruntime)
    else()
        message(FATAL_ERROR "ONNX Runtime target not found from find_package(onnxruntime).")
    endif()
endif()

add_library(
    bytetrack_cpp_vendor
    STATIC
    third_party/ByteTrack-cpp/src/BYTETracker.cpp
    third_party/ByteTrack-cpp/src/KalmanFilter.cpp
    third_party/ByteTrack-cpp/src/lapjv.cpp
    third_party/ByteTrack-cpp/src/Object.cpp
    third_party/ByteTrack-cpp/src/Rect.cpp
    third_party/ByteTrack-cpp/src/STrack.cpp
)

target_include_directories(
    bytetrack_cpp_vendor
    PUBLIC
    third_party/ByteTrack-cpp/include
)

target_link_libraries(bytetrack_cpp_vendor PUBLIC Eigen3::Eigen)

pybind11_add_module(
    cvui_cpp_inference
    src/module.cpp
    src/inference_core.cpp
)

target_include_directories(cvui_cpp_inference PRIVATE include)

if(MSVC)
    target_compile_definitions(cvui_cpp_inference PRIVATE Py_NO_LINK_LIB)
endif()

if(WIN32 AND Python_LIBRARY)
    get_filename_component(PYTHON_LIBRARY_DIR "${Python_LIBRARY}" DIRECTORY)
    target_link_directories(cvui_cpp_inference PRIVATE "${PYTHON_LIBRARY_DIR}")
endif()

target_link_libraries(
    cvui_cpp_inference
    PRIVATE
    ${OpenCV_LIBS}
    ${ONNXRUNTIME_TARGET}
    bytetrack_cpp_vendor
)
