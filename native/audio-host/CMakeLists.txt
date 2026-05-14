cmake_minimum_required(VERSION 3.24)

# CMake 4.x requires explicit C language when JUCE FetchContent enables it
# internally. Without this, Generate step fails with CMAKE_C_COMPILE_OBJECT.
project(echo_audio_host VERSION 0.1.0 LANGUAGES C CXX)

include(FetchContent)

set(JUCE_VERSION "8.0.12" CACHE STRING "JUCE version to fetch")
set(JUCE_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(JUCE_BUILD_EXTRAS OFF CACHE BOOL "" FORCE)
set(JUCE_BUILD_HELPER_TOOLS OFF CACHE BOOL "" FORCE)

if(WIN32)
  option(ECHO_ENABLE_ASIO "Enable JUCE ASIO support in echo-audio-host" ON)
else()
  option(ECHO_ENABLE_ASIO "Enable JUCE ASIO support in echo-audio-host" OFF)
endif()

FetchContent_Declare(
  JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG ${JUCE_VERSION}
  GIT_SHALLOW TRUE
)

FetchContent_MakeAvailable(JUCE)

set(ECHO_AUDIO_ENGINE_SOURCES
  ../audio-engine/ChannelBalanceProcessor.cpp
  ../audio-engine/EqMessageProtocol.cpp
  ../audio-engine/EqPresetStore.cpp
  ../audio-engine/EqProcessor.cpp
)

set(ECHO_JUCE_DEFINITIONS
  JUCE_DISPLAY_SPLASH_SCREEN=0
  JUCE_REPORT_APP_USAGE=0
  JUCE_USE_CURL=0
  JUCE_WEB_BROWSER=0
  JUCE_ASIO=$<BOOL:${ECHO_ENABLE_ASIO}>
  ECHO_ENABLE_ASIO=$<BOOL:${ECHO_ENABLE_ASIO}>
)

set(ECHO_JUCE_LIBRARIES
  juce::juce_audio_basics
  juce::juce_audio_devices
  juce::juce_core
  juce::juce_gui_basics
  juce::juce_recommended_config_flags
  juce::juce_recommended_lto_flags
  juce::juce_recommended_warning_flags
)

juce_add_console_app(echo-audio-host
  PRODUCT_NAME "echo-audio-host"
)

target_sources(echo-audio-host
  PRIVATE
    ${ECHO_AUDIO_ENGINE_SOURCES}
    src/main.cpp
)

target_compile_features(echo-audio-host PRIVATE cxx_std_17)

target_compile_definitions(echo-audio-host
  PRIVATE
    ${ECHO_JUCE_DEFINITIONS}
)

target_link_libraries(echo-audio-host
  PRIVATE
    ${ECHO_JUCE_LIBRARIES}
)

if(WIN32)
  target_link_libraries(echo-audio-host PRIVATE shell32 ole32)
endif()

juce_add_console_app(echo-audio-engine-tests
  PRODUCT_NAME "echo-audio-engine-tests"
)

target_sources(echo-audio-engine-tests
  PRIVATE
    ${ECHO_AUDIO_ENGINE_SOURCES}
    tests/audio_engine_tests.cpp
)

target_compile_features(echo-audio-engine-tests PRIVATE cxx_std_17)
set_target_properties(echo-audio-engine-tests PROPERTIES EXCLUDE_FROM_ALL TRUE)
target_compile_definitions(echo-audio-engine-tests
  PRIVATE
    ${ECHO_JUCE_DEFINITIONS}
    ECHO_AUDIO_ENGINE_TESTS=1
)

target_link_libraries(echo-audio-engine-tests
  PRIVATE
    ${ECHO_JUCE_LIBRARIES}
)

enable_testing()
add_test(NAME echo-audio-engine-tests COMMAND echo-audio-engine-tests)
