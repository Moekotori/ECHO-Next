cmake_minimum_required(VERSION 3.24)

project(echo_audio_host VERSION 0.1.0 LANGUAGES CXX)

include(FetchContent)

set(JUCE_VERSION "8.0.12" CACHE STRING "JUCE version to fetch")
set(JUCE_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(JUCE_BUILD_EXTRAS OFF CACHE BOOL "" FORCE)
set(JUCE_BUILD_HELPER_TOOLS OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
  JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG ${JUCE_VERSION}
  GIT_SHALLOW TRUE
)

FetchContent_MakeAvailable(JUCE)

juce_add_console_app(echo-audio-host
  PRODUCT_NAME "echo-audio-host"
)

target_sources(echo-audio-host
  PRIVATE
    src/main.cpp
)

target_compile_features(echo-audio-host PRIVATE cxx_std_17)

target_compile_definitions(echo-audio-host
  PRIVATE
    JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_REPORT_APP_USAGE=0
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_ASIO=1
)

target_link_libraries(echo-audio-host
  PRIVATE
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_core
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)

if(WIN32)
  target_link_libraries(echo-audio-host PRIVATE shell32)
endif()
