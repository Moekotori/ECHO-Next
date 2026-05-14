#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include "../../audio-engine/EqMessageProtocol.h"
#include "../../audio-engine/EqProcessor.h"
#include "../../audio-engine/ChannelBalanceProcessor.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#if JUCE_WINDOWS
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#include <shellapi.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <propsys.h>
#include <wrl/client.h>
#elif JUCE_LINUX
#include <cstdio>
#endif

#ifndef ECHO_ENABLE_ASIO
#define ECHO_ENABLE_ASIO 0
#endif

namespace
{
struct Options
{
    bool list = false;
    bool asio = false;
    bool exclusive = false;
    int sampleRate = 44100;
    int channels = 2;
    int deviceIndex = -1;
    int bufferSize = 0;
    int fifoCapacityMs = 0;
    int startupPrebufferMs = 0;
    int startupPrebufferTimeoutMs = 0;
    int eqControlPort = 0;
    double volume = 1.0;
    juce::String deviceName;
};

struct DeviceDescriptor
{
    int index = -1;
    juce::String typeName;
    juce::String name;
    int sampleRate = 0;
    int sharedSampleRate = 0;
    bool isDefault = false;
    bool isAsio = false;
};

enum class DeviceListMode
{
    Shared,
    Exclusive,
    Asio,
};

void logLine(const std::string& message)
{
    std::cerr << "[echo-audio-host] " << message << std::endl;
}

long long elapsedMs(std::chrono::steady_clock::time_point started)
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count();
}

void writeJsonLine(const std::string& json)
{
    std::cout << json << std::endl;
}

std::string jsonEscape(const juce::String& input)
{
    std::string source = input.toStdString();
    std::string result;
    result.reserve(source.size() + 8);

    for (char ch : source)
    {
        switch (ch)
        {
            case '\\': result += "\\\\"; break;
            case '"': result += "\\\""; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            default: result += ch; break;
        }
    }

    return result;
}

int parseInt(const juce::String& value, int fallback)
{
    if (value.isEmpty())
        return fallback;

    try
    {
        return std::stoi(value.toStdString());
    }
    catch (...)
    {
        return fallback;
    }
}

double parseDouble(const juce::String& value, double fallback)
{
    if (value.isEmpty())
        return fallback;

    try
    {
        return std::stod(value.toStdString());
    }
    catch (...)
    {
        return fallback;
    }
}

std::vector<juce::String> getCommandLineArgs(int argc, char* argv[])
{
#if JUCE_WINDOWS
    int wideArgc = 0;
    LPWSTR* wideArgv = CommandLineToArgvW(GetCommandLineW(), &wideArgc);
    std::vector<juce::String> wideArgs;

    if (wideArgv != nullptr)
    {
        wideArgs.reserve(static_cast<size_t>(wideArgc));

        for (int i = 0; i < wideArgc; ++i)
            wideArgs.emplace_back(wideArgv[i]);

        LocalFree(wideArgv);
        return wideArgs;
    }
#endif

    std::vector<juce::String> args;
    args.reserve(static_cast<size_t>(std::max(argc, 0)));

    for (int i = 0; i < argc; ++i)
        args.emplace_back(argv[i] != nullptr ? juce::String::fromUTF8(argv[i]) : juce::String());

    return args;
}

Options parseOptions(const std::vector<juce::String>& args)
{
    Options options;

    for (size_t i = 1; i < args.size(); ++i)
    {
        const auto arg = args[i];

        if (arg == "-list")
        {
            options.list = true;
        }
        else if (arg == "-asio")
        {
            options.asio = true;
        }
        else if (arg == "-exclusive")
        {
            options.exclusive = true;
        }
        else if (arg == "-sr" && i + 1 < args.size())
        {
            options.sampleRate = std::max(1, parseInt(args[++i], options.sampleRate));
        }
        else if (arg == "-ch" && i + 1 < args.size())
        {
            options.channels = std::max(1, std::min(8, parseInt(args[++i], options.channels)));
        }
        else if (arg == "-device-index" && i + 1 < args.size())
        {
            options.deviceIndex = parseInt(args[++i], -1);
        }
        else if (arg == "-device" && i + 1 < args.size())
        {
            options.deviceName = args[++i];
        }
        else if ((arg == "-buffer" || arg == "-buffer-size") && i + 1 < args.size())
        {
            options.bufferSize = std::max(0, parseInt(args[++i], options.bufferSize));
        }
        else if (arg == "-fifo-ms" && i + 1 < args.size())
        {
            options.fifoCapacityMs = std::max(0, parseInt(args[++i], options.fifoCapacityMs));
        }
        else if (arg == "-prebuffer-ms" && i + 1 < args.size())
        {
            options.startupPrebufferMs = std::max(0, parseInt(args[++i], options.startupPrebufferMs));
        }
        else if (arg == "-prebuffer-timeout-ms" && i + 1 < args.size())
        {
            options.startupPrebufferTimeoutMs = std::max(0, parseInt(args[++i], options.startupPrebufferTimeoutMs));
        }
        else if (arg == "-eq-port" && i + 1 < args.size())
        {
            options.eqControlPort = std::max(0, parseInt(args[++i], options.eqControlPort));
        }
        else if (arg == "-vol" && i + 1 < args.size())
        {
            options.volume = std::max(0.0, std::min(1.0, parseDouble(args[++i], options.volume)));
        }
    }

    return options;
}

bool isAsioType(const juce::String& typeName)
{
    return typeName.containsIgnoreCase("asio");
}

bool isExclusiveType(const juce::String& typeName)
{
    return typeName.containsIgnoreCase("exclusive");
}

bool isPreferredSharedType(const juce::String& typeName)
{
    return ! isExclusiveType(typeName)
        && (typeName.containsIgnoreCase("windows audio")
            || typeName.containsIgnoreCase("wasapi")
            || typeName.containsIgnoreCase("alsa"));
}

int sharedTypePriority(const juce::String& typeName)
{
#if JUCE_WINDOWS
    if (typeName.containsIgnoreCase("shared"))
        return 0;

    if (typeName.containsIgnoreCase("windows audio") || typeName.containsIgnoreCase("wasapi"))
        return 1;

    if (typeName.containsIgnoreCase("directsound"))
        return 2;

    return 3;
#elif JUCE_LINUX
    if (typeName.containsIgnoreCase("alsa"))
        return 0;

    if (typeName.containsIgnoreCase("jack"))
        return 1;

    if (typeName.containsIgnoreCase("pulseaudio") || typeName.containsIgnoreCase("pulse"))
        return 2;

    return 3;
#else
    return 0;
#endif
}

bool shouldIncludeType(const juce::String& typeName, DeviceListMode mode)
{
    const bool asioType = isAsioType(typeName);
    const bool exclusiveType = isExclusiveType(typeName);

    if (mode == DeviceListMode::Asio)
        return asioType;

    if (asioType)
        return false;

    if (mode == DeviceListMode::Exclusive)
        return exclusiveType;

    return ! exclusiveType;
}

DeviceListMode getHostOutputMode(const Options& options)
{
    if (options.asio)
        return DeviceListMode::Asio;

    if (options.exclusive)
        return DeviceListMode::Exclusive;

    return DeviceListMode::Shared;
}

std::string getBackendName(const Options& options, const juce::String& typeName)
{
    if (options.asio || isAsioType(typeName))
        return "asio";

#if JUCE_WINDOWS
    if (options.exclusive || isExclusiveType(typeName))
        return "wasapi-exclusive";

    return "wasapi-shared";
#elif JUCE_LINUX
    if (options.exclusive || isExclusiveType(typeName))
        return "alsa-exclusive";

    if (typeName.containsIgnoreCase("jack"))
        return "jack";

    if (typeName.containsIgnoreCase("pulseaudio") || typeName.containsIgnoreCase("pulse"))
        return "pulseaudio";

    return "alsa";
#else
    return "coreaudio";
#endif
}

std::string getOpenFailurePrefix(const Options& options)
{
    if (options.asio)
        return "ASIO open failed: ";

#if JUCE_WINDOWS
    if (options.exclusive)
        return "WASAPI exclusive open failed: ";

    return "output open failed: ";
#elif JUCE_LINUX
    return "ALSA open failed: ";
#else
    return "output open failed: ";
#endif
}

int getDeviceBufferSize(const Options& options)
{
    if (options.bufferSize > 0)
        return options.bufferSize;

    if (options.exclusive || options.asio)
        return 2048;

#if JUCE_LINUX
    // ALSA/PipeWire shared mode needs a larger buffer to avoid underruns.
    return 2048;
#else
    return 512;
#endif
}

std::vector<int> buildBufferSizeAttempts(const Options& options)
{
    std::vector<int> buffers;

    const auto add = [&] (int size)
    {
        if (size > 0 && std::find(buffers.begin(), buffers.end(), size) == buffers.end())
            buffers.push_back(size);
    };

    add(getDeviceBufferSize(options));

    if (options.exclusive || options.asio)
    {
        add(2048);
        add(4096);
        add(8192);
    }

    return buffers;
}

int framesForMilliseconds(int sampleRate, int milliseconds)
{
    if (sampleRate <= 0 || milliseconds <= 0)
        return 0;

    return std::max(1, static_cast<int>(std::round((static_cast<double>(sampleRate) * milliseconds) / 1000.0)));
}

int getFifoCapacityFrames(const Options& options, int sampleRate)
{
    const int requestedFrames = framesForMilliseconds(sampleRate, options.fifoCapacityMs);

    if (requestedFrames > 0)
        return std::max(requestedFrames, getDeviceBufferSize(options) * 2);

    return std::max(sampleRate / 5, 4096);
}

int getStartupPrebufferFrames(const Options& options, int sampleRate)
{
    const int requestedFrames = framesForMilliseconds(sampleRate, options.startupPrebufferMs);

    if (requestedFrames > 0)
        return requestedFrames;

    if (options.exclusive || options.asio)
        return std::max(1, std::min(sampleRate / 50, 4096));

    return 0;
}

int getStartupPrebufferTimeoutMs(const Options& options)
{
    if (options.startupPrebufferTimeoutMs > 0)
        return options.startupPrebufferTimeoutMs;

    return 300;
}

int pickRate(const juce::Array<double>& rates, bool maxRate)
{
    if (rates.isEmpty())
        return 0;

    double picked = rates[0];

    for (auto rate : rates)
    {
        if (std::abs(rate - 48000.0) < 0.5 && ! maxRate)
            return 48000;

        picked = maxRate ? std::max(picked, rate) : picked;
    }

    return static_cast<int>(std::round(picked));
}

void createDeviceTypes(juce::OwnedArray<juce::AudioIODeviceType>& types)
{
    juce::AudioDeviceManager manager;
    manager.createAudioDeviceTypes(types);
}

#if JUCE_WINDOWS
const PROPERTYKEY echoPkeyDeviceFriendlyName = {
    { 0xa45c254e, 0xdf1c, 0x4efd, { 0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0 } },
    14
};

class ScopedComInitializer final
{
public:
    ScopedComInitializer()
    {
        result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        ownsInitialisation = SUCCEEDED(result);
    }

    ~ScopedComInitializer()
    {
        if (ownsInitialisation)
            CoUninitialize();
    }

    bool canUseCom() const
    {
        return SUCCEEDED(result) || result == RPC_E_CHANGED_MODE;
    }

private:
    HRESULT result = E_FAIL;
    bool ownsInitialisation = false;
};

struct CoreAudioEndpoint
{
    juce::String id;
    juce::String name;
    int mixSampleRate = 0;
    bool isDefault = false;
};

juce::String getEndpointId(IMMDevice* device)
{
    if (device == nullptr)
        return {};

    LPWSTR rawId = nullptr;
    if (FAILED(device->GetId(&rawId)) || rawId == nullptr)
    {
        if (rawId != nullptr)
            CoTaskMemFree(rawId);
        return {};
    }

    juce::String id(rawId);
    CoTaskMemFree(rawId);
    return id;
}

juce::String getEndpointFriendlyName(IMMDevice* device)
{
    if (device == nullptr)
        return {};

    Microsoft::WRL::ComPtr<IPropertyStore> properties;
    if (FAILED(device->OpenPropertyStore(STGM_READ, properties.GetAddressOf())))
        return {};

    PROPVARIANT value;
    PropVariantInit(&value);

    juce::String name;
    if (SUCCEEDED(properties->GetValue(echoPkeyDeviceFriendlyName, &value)) && value.vt == VT_LPWSTR && value.pwszVal != nullptr)
        name = juce::String(value.pwszVal);

    PropVariantClear(&value);
    return name;
}

int getEndpointMixSampleRate(IMMDevice* device)
{
    if (device == nullptr)
        return 0;

    Microsoft::WRL::ComPtr<IAudioClient> audioClient;
    if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(audioClient.GetAddressOf()))))
        return 0;

    WAVEFORMATEX* mixFormat = nullptr;
    if (FAILED(audioClient->GetMixFormat(&mixFormat)) || mixFormat == nullptr)
    {
        if (mixFormat != nullptr)
            CoTaskMemFree(mixFormat);
        return 0;
    }

    const int sampleRate = mixFormat->nSamplesPerSec > 0
        ? static_cast<int>(mixFormat->nSamplesPerSec)
        : 0;
    CoTaskMemFree(mixFormat);
    return sampleRate;
}

juce::String getDefaultEndpointId(IMMDeviceEnumerator& enumerator)
{
    Microsoft::WRL::ComPtr<IMMDevice> defaultDevice;

    if (SUCCEEDED(enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia, defaultDevice.GetAddressOf())))
        return getEndpointId(defaultDevice.Get());

    defaultDevice.Reset();
    if (SUCCEEDED(enumerator.GetDefaultAudioEndpoint(eRender, eConsole, defaultDevice.GetAddressOf())))
        return getEndpointId(defaultDevice.Get());

    return {};
}

std::vector<CoreAudioEndpoint> enumerateCoreAudioRenderEndpoints()
{
    ScopedComInitializer com;
    if (! com.canUseCom())
        return {};

    Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator;
    if (FAILED(CoCreateInstance(
            __uuidof(MMDeviceEnumerator),
            nullptr,
            CLSCTX_ALL,
            IID_PPV_ARGS(enumerator.GetAddressOf()))))
        return {};

    const auto defaultId = getDefaultEndpointId(*enumerator.Get());

    Microsoft::WRL::ComPtr<IMMDeviceCollection> collection;
    if (FAILED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, collection.GetAddressOf())))
        return {};

    UINT count = 0;
    if (FAILED(collection->GetCount(&count)))
        return {};

    std::vector<CoreAudioEndpoint> endpoints;
    endpoints.reserve(count);

    for (UINT i = 0; i < count; ++i)
    {
        Microsoft::WRL::ComPtr<IMMDevice> endpoint;
        if (FAILED(collection->Item(i, endpoint.GetAddressOf())))
            continue;

        const auto id = getEndpointId(endpoint.Get());
        endpoints.push_back({
            id,
            getEndpointFriendlyName(endpoint.Get()),
            getEndpointMixSampleRate(endpoint.Get()),
            defaultId.isNotEmpty() && id == defaultId,
        });
    }

    return endpoints;
}

bool isCoreAudioEndpointNameMatch(const juce::String& endpointName, const juce::String& juceDeviceName)
{
    return endpointName.isNotEmpty()
        && juceDeviceName.isNotEmpty()
        && (endpointName == juceDeviceName
            || endpointName.containsIgnoreCase(juceDeviceName)
            || juceDeviceName.containsIgnoreCase(endpointName));
}

const CoreAudioEndpoint* findCoreAudioEndpoint(
    const std::vector<CoreAudioEndpoint>& endpoints,
    const DeviceDescriptor& device)
{
    auto exact = std::find_if(endpoints.begin(), endpoints.end(), [&] (const CoreAudioEndpoint& endpoint)
    {
        return endpoint.name == device.name;
    });

    if (exact != endpoints.end())
        return &*exact;

    auto loose = std::find_if(endpoints.begin(), endpoints.end(), [&] (const CoreAudioEndpoint& endpoint)
    {
        return isCoreAudioEndpointNameMatch(endpoint.name, device.name);
    });

    return loose != endpoints.end() ? &*loose : nullptr;
}

int getFallbackSharedSampleRate()
{
    return 48000;
}

void applyCoreAudioSharedSampleRates(std::vector<DeviceDescriptor>& devices)
{
    const auto endpoints = enumerateCoreAudioRenderEndpoints();
    const auto defaultEndpoint = std::find_if(endpoints.begin(), endpoints.end(), [] (const CoreAudioEndpoint& endpoint)
    {
        return endpoint.isDefault && endpoint.mixSampleRate > 0;
    });

    for (auto& device : devices)
    {
        int sampleRate = 0;

        if (const auto* endpoint = findCoreAudioEndpoint(endpoints, device))
        {
            sampleRate = endpoint->mixSampleRate;
            device.isDefault = device.isDefault || endpoint->isDefault;
        }

        if (sampleRate <= 0 && device.isDefault && defaultEndpoint != endpoints.end())
            sampleRate = defaultEndpoint->mixSampleRate;

        if (sampleRate <= 0)
            sampleRate = getFallbackSharedSampleRate();

        device.sampleRate = sampleRate;
        device.sharedSampleRate = sampleRate;
    }
}
#else
int getFallbackSharedSampleRate()
{
    return 48000;
}

void applyCoreAudioSharedSampleRates(std::vector<DeviceDescriptor>& devices)
{
    for (auto& device : devices)
    {
        if (device.sharedSampleRate <= 0)
            device.sharedSampleRate = getFallbackSharedSampleRate();

        if (device.sampleRate <= 0)
            device.sampleRate = device.sharedSampleRate;
    }
}
#endif

std::vector<DeviceDescriptor> enumerateDevices(DeviceListMode mode, bool dedupe = true)
{
    juce::OwnedArray<juce::AudioIODeviceType> types;
    createDeviceTypes(types);

    std::vector<juce::AudioIODeviceType*> candidateTypes;

    for (auto* type : types)
    {
        if (type == nullptr)
            continue;

        if (! shouldIncludeType(type->getTypeName(), mode))
            continue;

        if (dedupe && mode == DeviceListMode::Shared && ! isPreferredSharedType(type->getTypeName()))
            continue;

        candidateTypes.push_back(type);
    }

    if (candidateTypes.empty())
    {
        for (auto* type : types)
        {
            if (type == nullptr)
                continue;

            if (shouldIncludeType(type->getTypeName(), mode))
                candidateTypes.push_back(type);
        }
    }

    std::sort(candidateTypes.begin(), candidateTypes.end(), [] (const auto* left, const auto* right)
    {
        return sharedTypePriority(left->getTypeName()) < sharedTypePriority(right->getTypeName());
    });

    std::vector<DeviceDescriptor> devices;
    std::set<std::string> seenDeviceNames;
    int nextIndex = 0;

    for (auto* type : candidateTypes)
    {
        type->scanForDevices();
        const auto names = type->getDeviceNames(false);
        const int defaultIndex = type->getDefaultDeviceIndex(false);

        for (int i = 0; i < names.size(); ++i)
        {
            const auto dedupeKey = names[i].toStdString();
            if (dedupe && mode != DeviceListMode::Asio && seenDeviceNames.find(dedupeKey) != seenDeviceNames.end())
                continue;

            seenDeviceNames.insert(dedupeKey);
            devices.push_back({
                nextIndex++,
                type->getTypeName(),
                names[i],
                0,
                0,
                i == defaultIndex,
                isAsioType(type->getTypeName()),
            });
        }
    }

    if (mode == DeviceListMode::Shared)
        applyCoreAudioSharedSampleRates(devices);

    return devices;
}

int listDevices(bool asioOnly)
{
    if (asioOnly && ! ECHO_ENABLE_ASIO)
    {
        logLine("ASIO device enumeration failed: ASIO support is disabled at build time (ECHO_ENABLE_ASIO=OFF)");
        return 2;
    }

    const auto devices = enumerateDevices(asioOnly ? DeviceListMode::Asio : DeviceListMode::Shared);

    if (asioOnly && devices.empty())
        logLine("ASIO device enumeration returned no devices");

    for (const auto& device : devices)
    {
        std::cout
            << device.index << "\t"
            << device.name.toRawUTF8() << "\t"
            << device.sampleRate << "\t"
            << (device.isDefault ? 1 : 0) << "\t"
            << device.sharedSampleRate << std::endl;
    }

    return 0;
}

juce::AudioIODeviceType* findTypeByName(juce::OwnedArray<juce::AudioIODeviceType>& types, const juce::String& typeName)
{
    for (auto* type : types)
    {
        if (type != nullptr && type->getTypeName() == typeName)
            return type;
    }

    return nullptr;
}

bool isLooseDeviceNameMatch(const juce::String& left, const juce::String& right)
{
    return left == right
        || left.containsIgnoreCase(right)
        || right.containsIgnoreCase(left);
}

DeviceDescriptor selectDevice(const Options& options)
{
    const auto devices = enumerateDevices(options.asio ? DeviceListMode::Asio : DeviceListMode::Shared);

    if (devices.empty())
        throw std::runtime_error("no output devices available");

    if (options.deviceName.isNotEmpty())
    {
        const auto found = std::find_if(devices.begin(), devices.end(), [&] (const DeviceDescriptor& device)
        {
            return device.name == options.deviceName || device.name.containsIgnoreCase(options.deviceName);
        });

        if (found != devices.end())
            return *found;

        logLine("No match for requested device name, falling back to device index/default");
    }

    if (options.deviceIndex >= 0)
    {
        const auto found = std::find_if(devices.begin(), devices.end(), [&] (const DeviceDescriptor& device)
        {
            return device.index == options.deviceIndex;
        });

        if (found != devices.end())
            return *found;

        logLine("Invalid device index " + std::to_string(options.deviceIndex) + ", falling back to default");
    }

    const auto defaultDevice = std::find_if(devices.begin(), devices.end(), [] (const DeviceDescriptor& device)
    {
        return device.isDefault;
    });

    return defaultDevice != devices.end() ? *defaultDevice : devices.front();
}

std::vector<DeviceDescriptor> buildOpenCandidates(const Options& options, const DeviceDescriptor& selected)
{
    std::vector<DeviceDescriptor> candidates;
    std::set<std::string> seen;

    const auto addCandidate = [&] (const DeviceDescriptor& device)
    {
        const auto key = device.typeName.toStdString() + "\n" + device.name.toStdString();
        if (seen.find(key) != seen.end())
            return;

        seen.insert(key);
        candidates.push_back(device);
    };

    const auto outputMode = getHostOutputMode(options);

    if (shouldIncludeType(selected.typeName, outputMode))
        addCandidate(selected);

    const auto allDevices = enumerateDevices(outputMode, false);

    for (const auto& device : allDevices)
    {
        if (isLooseDeviceNameMatch(device.name, selected.name))
            addCandidate(device);
    }

    if (selected.isDefault)
    {
        for (const auto& device : allDevices)
        {
            if (device.isDefault)
                addCandidate(device);
        }
    }

    return candidates;
}


class PcmRingAudioSource final : public juce::AudioSource
{
public:
    PcmRingAudioSource(
        int channelCount,
        int capacityFrames,
        double gainToUse,
        echo::EqProcessor& eqProcessorToUse,
        echo::ChannelBalanceProcessor& channelBalanceProcessorToUse)
        : channels(channelCount),
          gain(static_cast<float>(gainToUse)),
          fifo(capacityFrames),
          buffer(static_cast<size_t>(capacityFrames * channelCount), 0.0f),
          eqProcessor(eqProcessorToUse),
          channelBalanceProcessor(channelBalanceProcessorToUse)
    {
    }

    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override
    {
        eqProcessor.prepare(sampleRate, samplesPerBlockExpected, channels);
        channelBalanceProcessor.prepare(sampleRate, samplesPerBlockExpected, channels);
    }

    void releaseResources() override
    {
        eqProcessor.reset();
        channelBalanceProcessor.reset();
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        if (info.buffer == nullptr)
            return;

        info.clearActiveBufferRegion();

        int framesNeeded = info.numSamples;
        int outputOffset = 0;

        while (framesNeeded > 0)
        {
            int start1 = 0;
            int size1 = 0;
            int start2 = 0;
            int size2 = 0;
            fifo.prepareToRead(framesNeeded, start1, size1, start2, size2);

            const int framesRead = size1 + size2;
            if (framesRead <= 0)
            {
                if (! inputEnded.load(std::memory_order_acquire))
                {
                    underrunCallbacks.fetch_add(1, std::memory_order_relaxed);
                    underrunFrames.fetch_add(static_cast<uint64_t>(framesNeeded), std::memory_order_relaxed);
                }
                break;
            }

            copyToOutput(start1, size1, *info.buffer, info.startSample + outputOffset);
            copyToOutput(start2, size2, *info.buffer, info.startSample + outputOffset + size1);
            fifo.finishedRead(framesRead);

            framesPlayed.fetch_add(static_cast<uint64_t>(framesRead), std::memory_order_relaxed);
            framesNeeded -= framesRead;
            outputOffset += framesRead;
        }

        eqProcessor.processBlock(*info.buffer, info.startSample, info.numSamples);
        channelBalanceProcessor.processBlock(*info.buffer, info.startSample, info.numSamples);
    }

    bool push(const float* samples, int frameCount)
    {
        int written = 0;

        while (written < frameCount && ! stopRequested.load(std::memory_order_relaxed))
        {
            int start1 = 0;
            int size1 = 0;
            int start2 = 0;
            int size2 = 0;
            fifo.prepareToWrite(frameCount - written, start1, size1, start2, size2);

            const int framesWritable = size1 + size2;
            if (framesWritable <= 0)
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(4));
                continue;
            }

            copyFromInput(samples + written * channels, start1, size1);
            copyFromInput(samples + (written + size1) * channels, start2, size2);
            fifo.finishedWrite(framesWritable);
            written += framesWritable;
        }

        return written == frameCount;
    }

    void markInputEnded()
    {
        inputEnded.store(true, std::memory_order_release);
    }

    void requestStop()
    {
        stopRequested.store(true, std::memory_order_release);
    }

    bool isDrained() const
    {
        return inputEnded.load(std::memory_order_acquire) && fifo.getNumReady() == 0;
    }

    bool hasInputEnded() const
    {
        return inputEnded.load(std::memory_order_acquire);
    }

    int getReadyFrames() const
    {
        return fifo.getNumReady();
    }

    uint64_t getFramesPlayed() const
    {
        return framesPlayed.load(std::memory_order_relaxed);
    }

    uint64_t getUnderrunCallbacks() const
    {
        return underrunCallbacks.load(std::memory_order_relaxed);
    }

    uint64_t getUnderrunFrames() const
    {
        return underrunFrames.load(std::memory_order_relaxed);
    }

private:
    void copyFromInput(const float* source, int startFrame, int frameCount)
    {
        if (frameCount <= 0)
            return;

        std::memcpy(
            buffer.data() + static_cast<size_t>(startFrame * channels),
            source,
            static_cast<size_t>(frameCount * channels) * sizeof(float));
    }

    void copyToOutput(int startFrame, int frameCount, juce::AudioBuffer<float>& output, int outputStart)
    {
        if (frameCount <= 0)
            return;

        const float* source = buffer.data() + static_cast<size_t>(startFrame * channels);
        const int outputChannels = output.getNumChannels();

        for (int channel = 0; channel < outputChannels; ++channel)
        {
            float* destination = output.getWritePointer(channel, outputStart);
            const int sourceChannel = std::min(channel, channels - 1);

            for (int frame = 0; frame < frameCount; ++frame)
                destination[frame] = source[frame * channels + sourceChannel] * gain;
        }
    }

    const int channels;
    const float gain;
    juce::AbstractFifo fifo;
    std::vector<float> buffer;
    echo::EqProcessor& eqProcessor;
    echo::ChannelBalanceProcessor& channelBalanceProcessor;
    std::atomic<bool> inputEnded { false };
    std::atomic<bool> stopRequested { false };
    std::atomic<uint64_t> framesPlayed { 0 };
    std::atomic<uint64_t> underrunCallbacks { 0 };
    std::atomic<uint64_t> underrunFrames { 0 };
};

class EqControlServer final
{
public:
    EqControlServer(
        int portToUse,
        echo::EqProcessor& processorToUse,
        echo::ChannelBalanceProcessor& channelBalanceProcessorToUse)
        : port(portToUse),
          processor(processorToUse),
          channelBalanceProcessor(channelBalanceProcessorToUse)
    {
    }

    ~EqControlServer()
    {
        stop();
    }

    bool start()
    {
        if (port <= 0)
            return false;

        if (! listener.createListener(port, "127.0.0.1"))
        {
            logLine("EQ control listener failed on port " + std::to_string(port));
            return false;
        }

        running.store(true, std::memory_order_release);
        worker = std::thread([this]
        {
            run();
        });
        return true;
    }

    void stop()
    {
        running.store(false, std::memory_order_release);
        listener.close();

        if (client != nullptr)
            client->close();

        if (worker.joinable())
            worker.join();
    }

private:
    void run()
    {
        logLine("EQ control listener ready on port " + std::to_string(port));

        while (running.load(std::memory_order_acquire))
        {
            std::unique_ptr<juce::StreamingSocket> nextClient(listener.waitForNextConnection());

            if (nextClient == nullptr)
                continue;

            client = nextClient.get();
            handleClient(*nextClient);
            client = nullptr;
        }
    }

    void handleClient(juce::StreamingSocket& socket)
    {
        std::string pending;
        char bytes[1024] {};

        while (running.load(std::memory_order_acquire) && socket.isConnected())
        {
            const int ready = socket.waitUntilReady(true, 100);
            if (ready < 0)
                break;

            if (ready == 0)
                continue;

            const int read = socket.read(bytes, sizeof(bytes), false);

            if (read <= 0)
                break;

            pending.append(bytes, bytes + read);

            size_t newline = pending.find('\n');
            while (newline != std::string::npos)
            {
                const auto line = pending.substr(0, newline);
                pending.erase(0, newline + 1);

                if (! line.empty())
                {
                    const auto response = echo::EqMessageProtocol::handleJsonLine(line, processor, channelBalanceProcessor) + "\n";
                    socket.write(response.data(), static_cast<int>(response.size()));
                }

                newline = pending.find('\n');
            }
        }
    }

    const int port = 0;
    echo::EqProcessor& processor;
    echo::ChannelBalanceProcessor& channelBalanceProcessor;
    juce::StreamingSocket listener;
    juce::StreamingSocket* client = nullptr;
    std::thread worker;
    std::atomic<bool> running { false };
};

void stdinReader(PcmRingAudioSource& source, int channels)
{
#if JUCE_WINDOWS
    _setmode(_fileno(stdin), _O_BINARY);
#elif JUCE_LINUX
    std::setvbuf(stdin, nullptr, _IONBF, 0);
#endif

    constexpr size_t chunkBytes = 16 * 1024;
    const size_t frameBytes = static_cast<size_t>(channels) * sizeof(float);
    std::vector<char> chunk(chunkBytes);
    std::vector<char> pending;

    while (std::cin.good())
    {
        std::cin.read(chunk.data(), static_cast<std::streamsize>(chunk.size()));
        const auto bytesRead = static_cast<size_t>(std::cin.gcount());

        if (bytesRead == 0)
            break;

        pending.insert(pending.end(), chunk.begin(), chunk.begin() + static_cast<std::ptrdiff_t>(bytesRead));

        const size_t frameCount = pending.size() / frameBytes;
        if (frameCount == 0)
            continue;

        const size_t sampleCount = frameCount * static_cast<size_t>(channels);
        std::vector<float> samples(sampleCount);
        std::memcpy(samples.data(), pending.data(), sampleCount * sizeof(float));

        if (! source.push(samples.data(), static_cast<int>(frameCount)))
            break;

        pending.erase(pending.begin(), pending.begin() + static_cast<std::ptrdiff_t>(sampleCount * sizeof(float)));
    }

    source.markInputEnded();
}

int waitForInitialPcm(PcmRingAudioSource& source, int targetFrames, int timeoutMs)
{
    if (targetFrames <= 0)
        return 0;

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(std::max(1, timeoutMs));

    while (std::chrono::steady_clock::now() < deadline)
    {
        const int readyFrames = source.getReadyFrames();
        if (readyFrames >= targetFrames || source.hasInputEnded())
            return readyFrames;

        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    return source.getReadyFrames();
}

std::vector<int> buildSampleRateAttempts(const Options& options, const DeviceDescriptor& device)
{
    std::vector<int> rates;

    const auto add = [&] (int rate)
    {
        if (rate > 0 && std::find(rates.begin(), rates.end(), rate) == rates.end())
            rates.push_back(rate);
    };

    if (! options.exclusive && ! options.asio)
    {
        add(device.sharedSampleRate);
        add(options.sampleRate);
        add(48000);
        add(44100);
        add(device.sampleRate);
    }
    else
    {
        add(options.sampleRate);
    }

    return rates;
}

std::unique_ptr<juce::AudioIODevice> openDevice(
    juce::AudioIODeviceType& type,
    const DeviceDescriptor& descriptor,
    const Options& options,
    int& actualSampleRate,
    int& openedBufferFrames,
    int& actualBufferFrames)
{
    const auto createStarted = std::chrono::steady_clock::now();
    std::unique_ptr<juce::AudioIODevice> device(type.createDevice(descriptor.name, {}));
    logLine(
        "createDevice completed in " + std::to_string(elapsedMs(createStarted))
        + " ms for " + descriptor.name.toStdString());

    if (device == nullptr)
        throw std::runtime_error("failed to create output device");

    juce::BigInteger outputChannels;
    const int channelCount = std::max(1, options.channels);

    for (int i = 0; i < channelCount; ++i)
        outputChannels.setBit(i);

    juce::String lastError;
    const auto attempts = buildSampleRateAttempts(options, descriptor);
    const auto bufferAttempts = buildBufferSizeAttempts(options);

    for (const auto bufferSize : bufferAttempts)
    {
        for (const auto rate : attempts)
        {
            const auto openStarted = std::chrono::steady_clock::now();
            lastError = device->open({}, outputChannels, static_cast<double>(rate), bufferSize);
            logLine(
                "device->open(" + std::to_string(rate)
                + " Hz, " + std::to_string(channelCount)
                + " ch, buffer=" + std::to_string(bufferSize)
                + ") completed in " + std::to_string(elapsedMs(openStarted)) + " ms");

            if (lastError.isEmpty())
            {
                actualSampleRate = static_cast<int>(std::round(device->getCurrentSampleRate()));
                openedBufferFrames = bufferSize;
                actualBufferFrames = std::max(1, device->getCurrentBufferSizeSamples());
                if (options.exclusive && actualSampleRate != options.sampleRate)
                {
                    device->close();
                    throw std::runtime_error(
                        "output sample rate mismatch: requested "
                        + std::to_string(options.sampleRate)
                        + " Hz, opened "
                        + std::to_string(actualSampleRate)
                        + " Hz");
                }
                if (options.asio && actualSampleRate != options.sampleRate)
                {
                    logLine(
                        "ASIO opened at hardware sample rate "
                        + std::to_string(actualSampleRate)
                        + " Hz instead of requested "
                        + std::to_string(options.sampleRate)
                        + " Hz; decoder-side resampling will be required");
                }
                return device;
            }

            logLine("Open failed at " + std::to_string(rate) + " Hz, buffer=" + std::to_string(bufferSize) + ": " + lastError.toStdString());
        }
    }

    throw std::runtime_error(lastError.isNotEmpty() ? lastError.toStdString() : "failed to open output device");
}

std::unique_ptr<juce::AudioIODevice> openSelectedDevice(
    const Options& options,
    const DeviceDescriptor& selected,
    juce::OwnedArray<juce::AudioIODeviceType>& types,
    DeviceDescriptor& openedDescriptor,
    int& actualSampleRate,
    int& openedBufferFrames,
    int& actualBufferFrames)
{
    const auto candidates = buildOpenCandidates(options, selected);
    std::string lastError;

    for (const auto& candidate : candidates)
    {
        auto* type = findTypeByName(types, candidate.typeName);

        if (type == nullptr)
        {
            lastError = "device type disappeared: " + candidate.typeName.toStdString();
            logLine(lastError);
            continue;
        }

        type->scanForDevices();
        logLine(
            "Trying JUCE device type " + candidate.typeName.toStdString()
            + " for " + candidate.name.toStdString());

        try
        {
            int openedSampleRate = options.sampleRate;
            int openedBufferSizeFrames = getDeviceBufferSize(options);
            int actualBufferSizeFrames = openedBufferSizeFrames;
            auto device = openDevice(
                *type,
                candidate,
                options,
                openedSampleRate,
                openedBufferSizeFrames,
                actualBufferSizeFrames);
            openedDescriptor = candidate;
            actualSampleRate = openedSampleRate;
            openedBufferFrames = openedBufferSizeFrames;
            actualBufferFrames = actualBufferSizeFrames;
            logLine(
                "Opened output with " + candidate.typeName.toStdString()
                + " at " + std::to_string(actualSampleRate) + " Hz"
                + " requestedBuffer=" + std::to_string(getDeviceBufferSize(options)) + " frames"
                + " openedBuffer=" + std::to_string(openedBufferFrames) + " frames"
                + " actualBuffer=" + std::to_string(actualBufferFrames) + " frames");
            return device;
        }
        catch (const std::exception& error)
        {
            lastError = error.what();
            logLine(
                "Backend " + candidate.typeName.toStdString()
                + " failed for " + candidate.name.toStdString()
                + ": " + lastError);
        }
    }

    throw std::runtime_error(
        getOpenFailurePrefix(options)
        + "failed to open output device \"" + selected.name.toStdString()
        + "\": " + (lastError.empty() ? "no compatible backend" : lastError));
}

int runHost(const Options& options)
{
    if (options.asio && ! ECHO_ENABLE_ASIO)
        throw std::runtime_error("ASIO open failed: ASIO support is disabled at build time (ECHO_ENABLE_ASIO=OFF)");

    if (options.exclusive)
#if JUCE_WINDOWS
        logLine("WASAPI exclusive requested; shared fallback is disabled");
#elif JUCE_LINUX
        logLine("Exclusive mode requested; shared fallback is disabled");
#else
        logLine("Exclusive mode requested; shared fallback is disabled");
#endif

    if (options.asio)
        logLine("ASIO requested; shared fallback is disabled");

    const auto descriptor = selectDevice(options);
    logLine("Using device index " + std::to_string(descriptor.index) + ": " + descriptor.name.toStdString());

    juce::OwnedArray<juce::AudioIODeviceType> types;
    createDeviceTypes(types);

    int actualSampleRate = options.sampleRate;
    const int requestedDeviceBufferFrames = getDeviceBufferSize(options);
    int openedDeviceBufferFrames = requestedDeviceBufferFrames;
    int actualDeviceBufferFrames = requestedDeviceBufferFrames;
    auto openedDescriptor = descriptor;
    auto device = openSelectedDevice(
        options,
        descriptor,
        types,
        openedDescriptor,
        actualSampleRate,
        openedDeviceBufferFrames,
        actualDeviceBufferFrames);

    echo::EqProcessor eqProcessor;
    echo::ChannelBalanceProcessor channelBalanceProcessor;
    EqControlServer eqControlServer(options.eqControlPort, eqProcessor, channelBalanceProcessor);
    const bool eqControlReady = eqControlServer.start();
    const int fifoCapacityFrames = getFifoCapacityFrames(options, actualSampleRate);
    const int startupPrebufferFrames = getStartupPrebufferFrames(options, actualSampleRate);
    const int startupPrebufferTimeoutMs = getStartupPrebufferTimeoutMs(options);

    PcmRingAudioSource source(
        options.channels,
        fifoCapacityFrames,
        options.volume,
        eqProcessor,
        channelBalanceProcessor);
    juce::AudioSourcePlayer player;
    player.setSource(&source);

    const bool openedExclusive = ! options.asio && (options.exclusive || isExclusiveType(openedDescriptor.typeName));
    const int openedSharedSampleRate = (! openedExclusive && ! options.asio)
        ? (openedDescriptor.sharedSampleRate > 0 ? openedDescriptor.sharedSampleRate : actualSampleRate)
        : 0;

    std::thread reader(stdinReader, std::ref(source), options.channels);

    writeJsonLine(
        std::string("{\"ready\":true,\"sampleRate\":") + std::to_string(actualSampleRate)
        + ",\"hardwareSampleRate\":" + std::to_string(actualSampleRate)
        + ",\"sharedDeviceSampleRate\":" + std::to_string(openedSharedSampleRate)
        + ",\"sharedSampleRate\":" + std::to_string(openedSharedSampleRate)
        + ",\"channels\":" + std::to_string(options.channels)
        + ",\"exclusive\":" + std::string(openedExclusive ? "true" : "false")
        + ",\"eqControlPort\":" + std::to_string(eqControlReady ? options.eqControlPort : 0)
        + ",\"deviceBufferFrames\":" + std::to_string(actualDeviceBufferFrames)
        + ",\"nativeActualBufferFrames\":" + std::to_string(actualDeviceBufferFrames)
        + ",\"actualBufferFrames\":" + std::to_string(actualDeviceBufferFrames)
        + ",\"requestedDeviceBufferFrames\":" + std::to_string(requestedDeviceBufferFrames)
        + ",\"openedDeviceBufferFrames\":" + std::to_string(openedDeviceBufferFrames)
        + ",\"bufferSizeFallback\":" + std::string(openedDeviceBufferFrames != requestedDeviceBufferFrames ? "true" : "false")
        + ",\"fifoCapacityFrames\":" + std::to_string(fifoCapacityFrames)
        + ",\"startupPrebufferFrames\":" + std::to_string(startupPrebufferFrames)
        + ",\"startupPrebufferTimeoutMs\":" + std::to_string(startupPrebufferTimeoutMs)
        + ",\"dspActive\":" + std::string((eqProcessor.isEnabled() || channelBalanceProcessor.isEnabled()) ? "true" : "false")
        + ",\"backend\":\"" + getBackendName(options, openedDescriptor.typeName)
        + "\",\"deviceType\":\""
        + jsonEscape(openedDescriptor.typeName) + "\",\"deviceName\":\""
        + jsonEscape(openedDescriptor.name) + "\"}");

    const int prebufferedFrames = waitForInitialPcm(source, startupPrebufferFrames, startupPrebufferTimeoutMs);
    if (startupPrebufferFrames > 0)
        logLine("Initial PCM prebuffer before device start: " + std::to_string(prebufferedFrames) + " frames");

    device->start(&player);
    uint64_t lastReported = std::numeric_limits<uint64_t>::max();

    while (! source.isDrained())
    {
        const auto frames = source.getFramesPlayed();

        if (frames != lastReported)
        {
            writeJsonLine(
                std::string("{\"pos\":") + std::to_string(frames)
                + ",\"bufferedFrames\":" + std::to_string(source.getReadyFrames())
                + ",\"underrunCallbacks\":" + std::to_string(source.getUnderrunCallbacks())
                + ",\"underrunFrames\":" + std::to_string(source.getUnderrunFrames())
                + "}");
            lastReported = frames;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(33));
    }

    if (reader.joinable())
        reader.join();

    const auto finalFrames = source.getFramesPlayed();
    if (finalFrames != lastReported)
        writeJsonLine(
            std::string("{\"pos\":") + std::to_string(finalFrames)
            + ",\"bufferedFrames\":" + std::to_string(source.getReadyFrames())
            + ",\"underrunCallbacks\":" + std::to_string(source.getUnderrunCallbacks())
            + ",\"underrunFrames\":" + std::to_string(source.getUnderrunFrames())
            + "}");

    if (source.getUnderrunCallbacks() > 0)
    {
        logLine(
            "Output underruns: callbacks=" + std::to_string(source.getUnderrunCallbacks())
            + " frames=" + std::to_string(source.getUnderrunFrames()));
    }

    writeJsonLine("{\"event\":\"ended\"}");

    device->stop();
    player.setSource(nullptr);
    source.requestStop();
    eqControlServer.stop();

    return 0;
}
} // namespace

int main(int argc, char* argv[])
{
    try
    {
        juce::ScopedJuceInitialiser_GUI juceInitialiser;
        const auto options = parseOptions(getCommandLineArgs(argc, argv));

        if (options.list)
        {
            return listDevices(options.asio);
        }

        return runHost(options);
    }
    catch (const std::exception& error)
    {
        logLine(error.what());
        writeJsonLine("{\"event\":\"error\"}");
        return 1;
    }
}
