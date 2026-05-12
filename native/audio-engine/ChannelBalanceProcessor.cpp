#include "ChannelBalanceProcessor.h"

#include <algorithm>
#include <cmath>

namespace echo
{
namespace
{
constexpr float pi = 3.14159265358979323846f;

float dbToGain(float db)
{
    return std::pow(10.0f, db / 20.0f);
}

float moveTowards(float current, float target, float step)
{
    if (std::abs(target - current) <= std::abs(step))
        return target;

    return current + (target > current ? std::abs(step) : -std::abs(step));
}

float sanitize(float value)
{
    return std::isfinite(value) ? value : 0.0f;
}

ChannelBalanceMonoMode monoModeFromInt(int value)
{
    switch (value)
    {
        case static_cast<int>(ChannelBalanceMonoMode::SumToMono): return ChannelBalanceMonoMode::SumToMono;
        case static_cast<int>(ChannelBalanceMonoMode::LeftOnly): return ChannelBalanceMonoMode::LeftOnly;
        case static_cast<int>(ChannelBalanceMonoMode::RightOnly): return ChannelBalanceMonoMode::RightOnly;
        default: return ChannelBalanceMonoMode::Off;
    }
}

void applyMono(ChannelBalanceMonoMode mode, float left, float right, float& outputLeft, float& outputRight)
{
    switch (mode)
    {
        case ChannelBalanceMonoMode::SumToMono:
        {
            const float mono = (left + right) * 0.5f;
            outputLeft = mono;
            outputRight = mono;
            break;
        }
        case ChannelBalanceMonoMode::LeftOnly:
            outputLeft = left;
            outputRight = left;
            break;
        case ChannelBalanceMonoMode::RightOnly:
            outputLeft = right;
            outputRight = right;
            break;
        case ChannelBalanceMonoMode::Off:
        default:
            outputLeft = left;
            outputRight = right;
            break;
    }
}
} // namespace

float clampChannelBalance(float value)
{
    if (! std::isfinite(value))
        return 0.0f;

    return std::max(channelBalanceMinBalance, std::min(channelBalanceMaxBalance, value));
}

float clampChannelGainDb(float value)
{
    if (! std::isfinite(value))
        return 0.0f;

    return std::max(channelBalanceMinGainDb, std::min(channelBalanceMaxGainDb, value));
}

ChannelBalanceProcessor::ChannelBalanceProcessor() = default;

void ChannelBalanceProcessor::prepare(double sampleRate, int maximumBlockSize, int channelCount)
{
    currentSampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;
    preparedChannels = std::max(1, channelCount);
    preparedBlockSize = std::max(1, maximumBlockSize);
    updateSmoothingSteps();
    reset();
}

void ChannelBalanceProcessor::reset()
{
    const auto target = readTargetSnapshot();
    smoothedBalance = target.balance;
    smoothedLeftGainDb = target.leftGainDb;
    smoothedRightGainDb = target.rightGainDb;
    enabledMix = target.enabled ? 1.0f : 0.0f;
    swapMix = target.swapLeftRight ? 1.0f : 0.0f;
    monoMix = 1.0f;
    invertLeftMix = target.invertLeft ? 1.0f : 0.0f;
    invertRightMix = target.invertRight ? 1.0f : 0.0f;
    constantPowerMix = target.constantPower ? 1.0f : 0.0f;
    previousMonoMode = target.monoMode;
    activeMonoMode = target.monoMode;
    targetMonoMode = target.monoMode;
    clippingRisk.store(false, std::memory_order_release);
}

void ChannelBalanceProcessor::processBlock(juce::AudioBuffer<float>& buffer, int startSample, int numSamples)
{
    if (numSamples <= 0)
        return;

    const int channelCount = std::min(buffer.getNumChannels(), preparedChannels);

    if (channelCount <= 0)
        return;

    const auto target = readTargetSnapshot();
    updateSwitchTargets(target);

    balanceStep = (target.balance - smoothedBalance) / static_cast<float>(parameterSmoothingSamples);
    leftGainStepDb = (target.leftGainDb - smoothedLeftGainDb) / static_cast<float>(parameterSmoothingSamples);
    rightGainStepDb = (target.rightGainDb - smoothedRightGainDb) / static_cast<float>(parameterSmoothingSamples);

    bool risk = false;

    if (channelCount == 1)
    {
        auto* leftSamples = buffer.getWritePointer(0, startSample);

        for (int sample = 0; sample < numSamples; ++sample)
        {
            smoothedBalance = moveTowards(smoothedBalance, target.balance, balanceStep);
            smoothedLeftGainDb = moveTowards(smoothedLeftGainDb, target.leftGainDb, leftGainStepDb);
            enabledMix = moveTowards(enabledMix, target.enabled ? 1.0f : 0.0f, enabledStep);
            invertLeftMix = moveTowards(invertLeftMix, target.invertLeft ? 1.0f : 0.0f, invertLeftStep);
            constantPowerMix = moveTowards(constantPowerMix, target.constantPower ? 1.0f : 0.0f, constantPowerStep);

            float linearLeft = 1.0f;
            float linearRight = 1.0f;
            float constantLeft = 1.0f;
            float constantRight = 1.0f;
            calculateBalanceGains(smoothedBalance, false, linearLeft, linearRight);
            calculateBalanceGains(smoothedBalance, true, constantLeft, constantRight);
            const float balanceLeft = linearLeft + (constantLeft - linearLeft) * constantPowerMix;

            const float dry = leftSamples[sample];
            const float inverted = dry * (1.0f - (2.0f * invertLeftMix));
            const float wet = inverted * balanceLeft * dbToGain(smoothedLeftGainDb);
            const float mixed = dry + (wet - dry) * enabledMix;
            leftSamples[sample] = sanitize(mixed);

            if (std::abs(leftSamples[sample]) > 0.98f)
                risk = true;
        }

        clippingRisk.store(risk, std::memory_order_release);
        return;
    }

    auto* leftSamples = buffer.getWritePointer(0, startSample);
    auto* rightSamples = buffer.getWritePointer(1, startSample);

    for (int sample = 0; sample < numSamples; ++sample)
    {
        smoothedBalance = moveTowards(smoothedBalance, target.balance, balanceStep);
        smoothedLeftGainDb = moveTowards(smoothedLeftGainDb, target.leftGainDb, leftGainStepDb);
        smoothedRightGainDb = moveTowards(smoothedRightGainDb, target.rightGainDb, rightGainStepDb);
        enabledMix = moveTowards(enabledMix, target.enabled ? 1.0f : 0.0f, enabledStep);
        swapMix = moveTowards(swapMix, target.swapLeftRight ? 1.0f : 0.0f, swapStep);
        monoMix = moveTowards(monoMix, 1.0f, monoStep);
        invertLeftMix = moveTowards(invertLeftMix, target.invertLeft ? 1.0f : 0.0f, invertLeftStep);
        invertRightMix = moveTowards(invertRightMix, target.invertRight ? 1.0f : 0.0f, invertRightStep);
        constantPowerMix = moveTowards(constantPowerMix, target.constantPower ? 1.0f : 0.0f, constantPowerStep);

        float linearLeft = 1.0f;
        float linearRight = 1.0f;
        float constantLeft = 1.0f;
        float constantRight = 1.0f;
        calculateBalanceGains(smoothedBalance, false, linearLeft, linearRight);
        calculateBalanceGains(smoothedBalance, true, constantLeft, constantRight);
        const float balanceLeft = linearLeft + (constantLeft - linearLeft) * constantPowerMix;
        const float balanceRight = linearRight + (constantRight - linearRight) * constantPowerMix;

        const float dryLeft = leftSamples[sample];
        const float dryRight = rightSamples[sample];

        const float swappedLeft = dryLeft + (dryRight - dryLeft) * swapMix;
        const float swappedRight = dryRight + (dryLeft - dryRight) * swapMix;
        const float invertedLeft = swappedLeft * (1.0f - (2.0f * invertLeftMix));
        const float invertedRight = swappedRight * (1.0f - (2.0f * invertRightMix));
        const float balancedLeft = invertedLeft * balanceLeft * dbToGain(smoothedLeftGainDb);
        const float balancedRight = invertedRight * balanceRight * dbToGain(smoothedRightGainDb);

        float previousMonoLeft = balancedLeft;
        float previousMonoRight = balancedRight;
        float activeMonoLeft = balancedLeft;
        float activeMonoRight = balancedRight;
        applyMono(previousMonoMode, balancedLeft, balancedRight, previousMonoLeft, previousMonoRight);
        applyMono(activeMonoMode, balancedLeft, balancedRight, activeMonoLeft, activeMonoRight);

        const float wetLeft = previousMonoLeft + (activeMonoLeft - previousMonoLeft) * monoMix;
        const float wetRight = previousMonoRight + (activeMonoRight - previousMonoRight) * monoMix;
        const float outputLeft = dryLeft + (wetLeft - dryLeft) * enabledMix;
        const float outputRight = dryRight + (wetRight - dryRight) * enabledMix;

        leftSamples[sample] = sanitize(outputLeft);
        rightSamples[sample] = sanitize(outputRight);

        if (std::abs(leftSamples[sample]) > 0.98f || std::abs(rightSamples[sample]) > 0.98f)
            risk = true;
    }

    // First version intentionally affects only channel 0/1. Additional channels
    // are preserved for future expansion into a full channel matrix.
    clippingRisk.store(risk, std::memory_order_release);
}

void ChannelBalanceProcessor::setState(const ChannelBalanceState& state)
{
    targetEnabled.store(state.enabled, std::memory_order_release);
    atomicBalance.store(clampChannelBalance(state.balance), std::memory_order_release);
    atomicLeftGainDb.store(clampChannelGainDb(state.leftGainDb), std::memory_order_release);
    atomicRightGainDb.store(clampChannelGainDb(state.rightGainDb), std::memory_order_release);
    targetSwapLeftRight.store(state.swapLeftRight, std::memory_order_release);
    atomicMonoMode.store(static_cast<int>(state.monoMode), std::memory_order_release);
    targetInvertLeft.store(state.invertLeft, std::memory_order_release);
    targetInvertRight.store(state.invertRight, std::memory_order_release);
    targetConstantPower.store(state.constantPower, std::memory_order_release);
}

ChannelBalanceState ChannelBalanceProcessor::getState() const
{
    ChannelBalanceState state;
    state.enabled = targetEnabled.load(std::memory_order_acquire);
    state.balance = atomicBalance.load(std::memory_order_acquire);
    state.leftGainDb = atomicLeftGainDb.load(std::memory_order_acquire);
    state.rightGainDb = atomicRightGainDb.load(std::memory_order_acquire);
    state.swapLeftRight = targetSwapLeftRight.load(std::memory_order_acquire);
    state.monoMode = monoModeFromInt(atomicMonoMode.load(std::memory_order_acquire));
    state.invertLeft = targetInvertLeft.load(std::memory_order_acquire);
    state.invertRight = targetInvertRight.load(std::memory_order_acquire);
    state.constantPower = targetConstantPower.load(std::memory_order_acquire);
    return state;
}

void ChannelBalanceProcessor::resetToDefault()
{
    setState(ChannelBalanceState {});
}

bool ChannelBalanceProcessor::isEnabled() const
{
    return targetEnabled.load(std::memory_order_acquire);
}

bool ChannelBalanceProcessor::hasClippingRisk() const
{
    return clippingRisk.load(std::memory_order_acquire);
}

void ChannelBalanceProcessor::updateSmoothingSteps()
{
    parameterSmoothingSamples = std::max(1, static_cast<int>(currentSampleRate * 0.02));
    switchSmoothingSamples = std::max(1, static_cast<int>(currentSampleRate * 0.012));
}

ChannelBalanceProcessor::TargetSnapshot ChannelBalanceProcessor::readTargetSnapshot() const
{
    TargetSnapshot target;
    target.enabled = targetEnabled.load(std::memory_order_acquire);
    target.balance = clampChannelBalance(atomicBalance.load(std::memory_order_acquire));
    target.leftGainDb = clampChannelGainDb(atomicLeftGainDb.load(std::memory_order_acquire));
    target.rightGainDb = clampChannelGainDb(atomicRightGainDb.load(std::memory_order_acquire));
    target.swapLeftRight = targetSwapLeftRight.load(std::memory_order_acquire);
    target.monoMode = monoModeFromInt(atomicMonoMode.load(std::memory_order_acquire));
    target.invertLeft = targetInvertLeft.load(std::memory_order_acquire);
    target.invertRight = targetInvertRight.load(std::memory_order_acquire);
    target.constantPower = targetConstantPower.load(std::memory_order_acquire);
    return target;
}

void ChannelBalanceProcessor::updateSwitchTargets(const TargetSnapshot& target)
{
    if (targetMonoMode != target.monoMode)
    {
        previousMonoMode = activeMonoMode;
        targetMonoMode = target.monoMode;
        activeMonoMode = target.monoMode;
        monoMix = 0.0f;
    }

    enabledStep = ((target.enabled ? 1.0f : 0.0f) - enabledMix) / static_cast<float>(switchSmoothingSamples);
    swapStep = ((target.swapLeftRight ? 1.0f : 0.0f) - swapMix) / static_cast<float>(switchSmoothingSamples);
    monoStep = (1.0f - monoMix) / static_cast<float>(switchSmoothingSamples);
    invertLeftStep = ((target.invertLeft ? 1.0f : 0.0f) - invertLeftMix) / static_cast<float>(switchSmoothingSamples);
    invertRightStep = ((target.invertRight ? 1.0f : 0.0f) - invertRightMix) / static_cast<float>(switchSmoothingSamples);
    constantPowerStep = ((target.constantPower ? 1.0f : 0.0f) - constantPowerMix) / static_cast<float>(switchSmoothingSamples);
}

void ChannelBalanceProcessor::calculateBalanceGains(float balance, bool constantPower, float& leftGain, float& rightGain)
{
    const float safeBalance = clampChannelBalance(balance);

    if (! constantPower)
    {
        leftGain = safeBalance > 0.0f ? 1.0f - safeBalance : 1.0f;
        rightGain = safeBalance < 0.0f ? 1.0f + safeBalance : 1.0f;
        return;
    }

    const float pan = (safeBalance + 1.0f) * pi * 0.25f;
    const float compensation = std::sqrt(2.0f);
    leftGain = std::min(1.0f, std::cos(pan) * compensation);
    rightGain = std::min(1.0f, std::sin(pan) * compensation);
}
} // namespace echo
