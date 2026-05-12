#pragma once

#include "ChannelBalanceProcessor.h"
#include "EqProcessor.h"

#include <juce_core/juce_core.h>

#include <string>

namespace echo
{
class EqMessageProtocol
{
public:
    static std::string createStateMessage(const EqProcessor& processor);
    static std::string createChannelBalanceStateMessage(const ChannelBalanceProcessor& processor);
    static std::string handleJsonLine(
        const std::string& line,
        EqProcessor& processor,
        ChannelBalanceProcessor& channelBalanceProcessor);

private:
    static std::string createErrorMessage(const std::string& requestType, const std::string& message);
};
} // namespace echo
