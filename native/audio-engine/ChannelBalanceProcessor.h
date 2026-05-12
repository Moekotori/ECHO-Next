#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>

namespace echo
{
constexpr float channelBalanceMinBalance = -1.0f;
constexpr float channelBalanceMaxBalance = 1.0f;
constexpr float channelBalanceMinGainDb = -12.0f;
constexpr float channelBalanceMaxGainDb = 6.0f;

enum class ChannelBalanceMonoMode
{
    Off = 0,
    SumToMono = 1,
    LeftOnly = 2,
    RightOnly = 3,
};

struct ChannelBalanceState
{
    bool enabled = false;
    float balance = 0.0f;
    float leftGainDb = 0.0f;
    float rightGainDb = 0.0f;
    bool swapLeftRight = false;
    ChannelBalanceMonoMode monoMode = ChannelBalanceMonoMode::Off;
    bool invertLeft = false;
    bool invertRight = false;
    bool constantPower = true;
};

float clampChannelBalance(float value);
float clampChannelGainDb(float value);

class ChannelBalanceProcessor
{
public:
    ChannelBalanceProcessor();

    void prepare(double sampleRate, int maximumBlockSize, int channelCount);
    void reset();
    void processBlock(juce::AudioBuffer<float>& buffer, int startSample, int numSamples);

    void setState(const ChannelBalanceState& state);
    ChannelBalanceState getState() const;
    void resetToDefault();

    bool isEnabled() const;
    bool hasClippingRisk() const;

private:
    struct TargetSnapshot
    {
        bool enabled = false;
        float balance = 0.0f;
        float leftGainDb = 0.0f;
        float rightGainDb = 0.0f;
        bool swapLeftRight = false;
        ChannelBalanceMonoMode monoMode = ChannelBalanceMonoMode::Off;
        bool invertLeft = false;
        bool invertRight = false;
        bool constantPower = true;
    };

    void updateSmoothingSteps();
    TargetSnapshot readTargetSnapshot() const;
    void updateSwitchTargets(const TargetSnapshot& target);
    static void calculateBalanceGains(float balance, bool constantPower, float& leftGain, float& rightGain);

    double currentSampleRate = 44100.0;
    int preparedChannels = 0;
    int preparedBlockSize = 0;
    int parameterSmoothingSamples = 1;
    int switchSmoothingSamples = 1;

    float smoothedBalance = 0.0f;
    float smoothedLeftGainDb = 0.0f;
    float smoothedRightGainDb = 0.0f;
    float enabledMix = 0.0f;
    float swapMix = 0.0f;
    float monoMix = 0.0f;
    float invertLeftMix = 0.0f;
    float invertRightMix = 0.0f;
    float constantPowerMix = 1.0f;

    float balanceStep = 0.0f;
    float leftGainStepDb = 0.0f;
    float rightGainStepDb = 0.0f;
    float enabledStep = 0.0f;
    float swapStep = 0.0f;
    float monoStep = 0.0f;
    float invertLeftStep = 0.0f;
    float invertRightStep = 0.0f;
    float constantPowerStep = 0.0f;

    ChannelBalanceMonoMode previousMonoMode = ChannelBalanceMonoMode::Off;
    ChannelBalanceMonoMode activeMonoMode = ChannelBalanceMonoMode::Off;
    ChannelBalanceMonoMode targetMonoMode = ChannelBalanceMonoMode::Off;

    std::atomic<bool> targetEnabled { false };
    std::atomic<float> atomicBalance { 0.0f };
    std::atomic<float> atomicLeftGainDb { 0.0f };
    std::atomic<float> atomicRightGainDb { 0.0f };
    std::atomic<bool> targetSwapLeftRight { false };
    std::atomic<int> atomicMonoMode { static_cast<int>(ChannelBalanceMonoMode::Off) };
    std::atomic<bool> targetInvertLeft { false };
    std::atomic<bool> targetInvertRight { false };
    std::atomic<bool> targetConstantPower { true };
    std::atomic<bool> clippingRisk { false };
};
} // namespace echo
