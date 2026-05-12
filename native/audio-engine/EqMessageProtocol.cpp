#include "EqMessageProtocol.h"

#include <sstream>

namespace echo
{
namespace
{
std::string boolText(bool value)
{
    return value ? "true" : "false";
}

float getNumber(const juce::DynamicObject& object, const juce::Identifier& key, float fallback)
{
    const auto value = object.getProperty(key);
    return value.isDouble() || value.isInt() ? static_cast<float>(value) : fallback;
}

bool getBool(const juce::DynamicObject& object, const juce::Identifier& key, bool fallback)
{
    const auto value = object.getProperty(key);
    return value.isBool() ? static_cast<bool>(value) : fallback;
}

int getInt(const juce::DynamicObject& object, const juce::Identifier& key, int fallback)
{
    const auto value = object.getProperty(key);
    return value.isInt() || value.isDouble() ? static_cast<int>(value) : fallback;
}

std::string getString(const juce::DynamicObject& object, const juce::Identifier& key)
{
    const auto value = object.getProperty(key);
    return value.isString() ? value.toString().toStdString() : std::string();
}

ChannelBalanceMonoMode parseMonoMode(const std::string& value, ChannelBalanceMonoMode fallback)
{
    if (value == "sum")
        return ChannelBalanceMonoMode::SumToMono;

    if (value == "left")
        return ChannelBalanceMonoMode::LeftOnly;

    if (value == "right")
        return ChannelBalanceMonoMode::RightOnly;

    if (value == "off")
        return ChannelBalanceMonoMode::Off;

    return fallback;
}

std::string monoModeText(ChannelBalanceMonoMode mode)
{
    switch (mode)
    {
        case ChannelBalanceMonoMode::SumToMono: return "sum";
        case ChannelBalanceMonoMode::LeftOnly: return "left";
        case ChannelBalanceMonoMode::RightOnly: return "right";
        case ChannelBalanceMonoMode::Off:
        default: return "off";
    }
}

ChannelBalanceState readChannelBalanceState(const juce::DynamicObject& object, const ChannelBalanceState& fallback)
{
    ChannelBalanceState state = fallback;
    state.enabled = getBool(object, "enabled", state.enabled);
    state.balance = clampChannelBalance(getNumber(object, "balance", state.balance));
    state.leftGainDb = clampChannelGainDb(getNumber(object, "leftGainDb", state.leftGainDb));
    state.rightGainDb = clampChannelGainDb(getNumber(object, "rightGainDb", state.rightGainDb));
    state.swapLeftRight = getBool(object, "swapLeftRight", state.swapLeftRight);
    state.monoMode = parseMonoMode(getString(object, "monoMode"), state.monoMode);
    state.invertLeft = getBool(object, "invertLeft", state.invertLeft);
    state.invertRight = getBool(object, "invertRight", state.invertRight);
    state.constantPower = getBool(object, "constantPower", state.constantPower);
    return state;
}

} // namespace

std::string EqMessageProtocol::createStateMessage(const EqProcessor& processor)
{
    const auto state = processor.getState();
    std::ostringstream output;
    output << "{\"type\":\"eq:state\","
           << "\"enabled\":" << boolText(state.enabled) << ','
           << "\"preampDb\":" << state.preampDb << ','
           << "\"presetName\":\"" << juce::JSON::escapeString(state.presetName).toStdString() << "\","
           << "\"clippingRisk\":" << boolText(processor.hasClippingRisk()) << ','
           << "\"bands\":[";

    for (int index = 0; index < eqBandCount; ++index)
    {
        if (index > 0)
            output << ',';

        output << "{\"frequencyHz\":" << state.bandFrequenciesHz[static_cast<size_t>(index)]
               << ",\"gainDb\":" << state.bandGainsDb[static_cast<size_t>(index)]
               << ",\"q\":1}";
    }

    output << "]}";
    return output.str();
}

std::string EqMessageProtocol::createChannelBalanceStateMessage(const ChannelBalanceProcessor& processor)
{
    const auto state = processor.getState();
    std::ostringstream output;
    output << "{\"type\":\"channelBalance:state\","
           << "\"ok\":true,"
           << "\"enabled\":" << boolText(state.enabled) << ','
           << "\"balance\":" << state.balance << ','
           << "\"leftGainDb\":" << state.leftGainDb << ','
           << "\"rightGainDb\":" << state.rightGainDb << ','
           << "\"swapLeftRight\":" << boolText(state.swapLeftRight) << ','
           << "\"monoMode\":\"" << monoModeText(state.monoMode) << "\","
           << "\"invertLeft\":" << boolText(state.invertLeft) << ','
           << "\"invertRight\":" << boolText(state.invertRight) << ','
           << "\"constantPower\":" << boolText(state.constantPower) << ','
           << "\"clippingRisk\":" << boolText(processor.hasClippingRisk())
           << "}";
    return output.str();
}

std::string EqMessageProtocol::handleJsonLine(
    const std::string& line,
    EqProcessor& processor,
    ChannelBalanceProcessor& channelBalanceProcessor)
{
    const auto parsed = juce::JSON::parse(juce::String::fromUTF8(line.data(), static_cast<int>(line.size())));
    const auto* object = parsed.getDynamicObject();

    if (object == nullptr)
        return createErrorMessage("unknown", "invalid_json");

    const auto type = getString(*object, "type");

    if (type == "eq:get-state")
        return createStateMessage(processor);

    if (type == "channelBalance.getState" || type == "channelBalance:get-state")
        return createChannelBalanceStateMessage(channelBalanceProcessor);

    if (type == "channelBalance.setState" || type == "channelBalance:set-state")
    {
        const auto stateValue = object->getProperty("state");
        const auto* stateObject = stateValue.getDynamicObject();
        const auto nextState = stateObject != nullptr
            ? readChannelBalanceState(*stateObject, channelBalanceProcessor.getState())
            : readChannelBalanceState(*object, channelBalanceProcessor.getState());
        channelBalanceProcessor.setState(nextState);
        return createChannelBalanceStateMessage(channelBalanceProcessor);
    }

    if (type == "channelBalance.reset" || type == "channelBalance:reset")
    {
        channelBalanceProcessor.resetToDefault();
        return createChannelBalanceStateMessage(channelBalanceProcessor);
    }

    if (type == "eq:set-enabled")
    {
        processor.setEnabled(getBool(*object, "enabled", false));
        return createStateMessage(processor);
    }

    if (type == "eq:set-band-gain")
    {
        const int band = getInt(*object, "band", -1);

        if (! processor.setBandGainDb(band, getNumber(*object, "gainDb", 0.0f)))
            return createErrorMessage(type, "invalid_band_index");

        return createStateMessage(processor);
    }

    if (type == "eq:set-band-frequency")
    {
        const int band = getInt(*object, "band", -1);

        if (! processor.setBandFrequencyHz(band, getNumber(*object, "frequencyHz", eqFrequenciesHz[0])))
            return createErrorMessage(type, "invalid_band_index");

        return createStateMessage(processor);
    }

    if (type == "eq:set-preamp")
    {
        processor.setPreampDb(getNumber(*object, "preampDb", 0.0f));
        return createStateMessage(processor);
    }

    if (type == "eq:reset")
    {
        processor.resetFlat();
        return createStateMessage(processor);
    }

    if (type == "eq:set-preset")
    {
        processor.setPreampDb(getNumber(*object, "preampDb", 0.0f));
        const auto bands = object->getProperty("bands");
        const auto* bandArray = bands.getArray();

        if (bandArray == nullptr || bandArray->size() != eqBandCount)
            return createErrorMessage(type, "invalid_preset_bands");

        for (int index = 0; index < eqBandCount; ++index)
        {
            const auto* bandObject = bandArray->getReference(index).getDynamicObject();
            if (bandObject == nullptr)
                return createErrorMessage(type, "invalid_preset_band");

            processor.setBandFrequencyHz(index, getNumber(*bandObject, "frequencyHz", eqFrequenciesHz[static_cast<size_t>(index)]));
            processor.setBandGainDb(index, getNumber(*bandObject, "gainDb", 0.0f));
        }

        return createStateMessage(processor);
    }

    return createErrorMessage(type.empty() ? "unknown" : type, "unsupported_eq_command");
}

std::string EqMessageProtocol::createErrorMessage(const std::string& requestType, const std::string& message)
{
    return std::string("{\"type\":\"eq:error\",\"requestType\":\"")
        + juce::JSON::escapeString(requestType).toStdString()
        + "\",\"message\":\""
        + juce::JSON::escapeString(message).toStdString()
        + "\"}";
}
} // namespace echo
