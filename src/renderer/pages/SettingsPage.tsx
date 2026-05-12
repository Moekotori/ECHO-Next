import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Check,
  Download,
  FileAudio,
  Globe2,
  Headphones,
  Info,
  Link2,
  MessageSquare,
  Palette,
  Pause,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Square,
  Trash2,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AudioDeviceInfo, AudioOutputMode, AudioOutputSettings, AudioStatus } from '../../shared/types/audio';
import { LibraryDiagnosticsPanel } from '../components/library/LibraryDiagnosticsPanel';
import { LibraryFoldersPanel } from '../components/library/LibraryFoldersPanel';

const isDevBuild = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);

type SettingsNavKey = 'general' | 'playback' | 'integrations' | 'remote' | 'eq' | 'appearance' | 'library' | 'about' | 'danger';

type SettingsNavItem = {
  key: SettingsNavKey;
  label: string;
  description: string;
  icon: LucideIcon;
};

type SettingSectionProps = {
  id: SettingsNavKey;
  activeKey: SettingsNavKey;
  icon: LucideIcon;
  title: string;
  children: ReactNode;
};

type SettingRowProps = {
  title: string;
  description: string;
  children: ReactNode;
};

const settingsNavItems: SettingsNavItem[] = [
  { key: 'general', label: '通用', description: '语言、窗口与基础行为', icon: MessageSquare },
  { key: 'playback', label: '播放', description: '输出、缓冲与播放控制', icon: Zap },
  { key: 'integrations', label: '联动', description: '账号登录、Discord、外部设备', icon: Link2 },
  { key: 'remote', label: '网盘 / 远程', description: 'NAS、WebDAV、Subsonic', icon: Globe2 },
  { key: 'eq', label: 'EQ', description: '均衡器与输出安全', icon: SlidersHorizontal },
  { key: 'appearance', label: '外观', description: '主题、字体、背景', icon: Palette },
  { key: 'library', label: '媒体库', description: '导入、扫描与清理', icon: Download },
  { key: 'about', label: '关于 / 高级', description: '版本、更新与开发工具', icon: Info },
  { key: 'danger', label: '危险操作', description: '恢复与网络安全', icon: Trash2 },
];

const formatRate = (value: number | null): string => {
  if (!value) {
    return 'n/a';
  }

  return `${value} Hz`;
};

const formatBool = (value: boolean): string => (value ? 'yes' : 'no');

const statusRows = (status: AudioStatus | null): Array<{ label: string; value: string }> => [
  { label: 'state', value: status?.state ?? 'loading' },
  { label: 'fileSampleRate', value: formatRate(status?.fileSampleRate ?? null) },
  { label: 'decoderOutputSampleRate', value: formatRate(status?.decoderOutputSampleRate ?? null) },
  { label: 'requestedOutputSampleRate', value: formatRate(status?.requestedOutputSampleRate ?? null) },
  { label: 'actualDeviceSampleRate', value: formatRate(status?.actualDeviceSampleRate ?? null) },
  { label: 'sharedDeviceSampleRate', value: formatRate(status?.sharedDeviceSampleRate ?? null) },
  { label: 'outputMode', value: status?.outputMode ?? 'shared' },
  { label: 'outputBackend', value: status?.outputBackend ?? 'n/a' },
  { label: 'outputDeviceType', value: status?.outputDeviceType ?? 'n/a' },
  { label: 'outputDeviceName', value: status?.outputDeviceName ?? 'n/a' },
  { label: 'resampling', value: formatBool(status?.resampling ?? false) },
  { label: 'bitPerfectCandidate', value: formatBool(status?.bitPerfectCandidate ?? false) },
  { label: 'sampleRateMismatch', value: formatBool(status?.sampleRateMismatch ?? false) },
];

const SettingSection = ({ id, activeKey, icon: Icon, title, children }: SettingSectionProps): JSX.Element => (
  <section className="settings-section" id={`settings-sec-${id}`} data-visible={activeKey === id}>
    <div className="section-title">
      <Icon size={18} />
      <h2>{title}</h2>
    </div>
    {children}
  </section>
);

const SettingRow = ({ title, description, children }: SettingRowProps): JSX.Element => (
  <div className="setting-row">
    <div className="setting-info">
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
    {children}
  </div>
);

const ChipButton = ({
  active,
  children,
  onClick,
}: {
  active?: boolean;
  children: string;
  onClick?: () => void;
}): JSX.Element => (
  <button className={`list-filter-chip ${active ? 'active' : ''}`} type="button" onClick={onClick}>
    {children}
    {active ? <Check size={13} /> : null}
  </button>
);

const ToggleButton = ({ active }: { active?: boolean }): JSX.Element => (
  <button className={`toggle-btn ${active ? 'active' : ''}`} type="button" aria-pressed={active}>
    <span />
  </button>
);

export const SettingsPage = (): JSX.Element => {
  const [activeSection, setActiveSection] = useState<SettingsNavKey>('general');
  const [settingsQuery, setSettingsQuery] = useState('');
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [outputMode, setOutputMode] = useState<AudioOutputMode>('shared');
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [lastOpenedFile, setLastOpenedFile] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visibleNavItems = useMemo(() => {
    const query = settingsQuery.trim().toLowerCase();

    if (!query) {
      return settingsNavItems;
    }

    return settingsNavItems.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(query));
  }, [settingsQuery]);

  const compatibleDevices = useMemo(
    () => devices.filter((device) => (outputMode === 'asio' ? device.outputMode === 'asio' : device.outputMode === 'shared')),
    [devices, outputMode],
  );
  const selectedDevice = compatibleDevices.find((device) => device.id === selectedDeviceId) ?? null;

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await window.echo.audio.getStatus());
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const nextDevices = await window.echo.audio.listDevices();
      setDevices(nextDevices);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshDevices();
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 1000);

    return () => window.clearInterval(timer);
  }, [refreshDevices, refreshStatus]);

  useEffect(() => {
    setOutputMode(status?.outputMode ?? 'shared');
  }, [status?.outputMode]);

  useEffect(() => {
    if (status?.outputDeviceId && devices.some((device) => device.id === status.outputDeviceId)) {
      setSelectedDeviceId(status.outputDeviceId);
    }
  }, [devices, status?.outputDeviceId]);

  useEffect(() => {
    if (compatibleDevices.length === 0) {
      setSelectedDeviceId('');
      return;
    }

    if (!compatibleDevices.some((device) => device.id === selectedDeviceId)) {
      setSelectedDeviceId(compatibleDevices.find((device) => device.isDefault)?.id ?? compatibleDevices[0].id);
    }
  }, [compatibleDevices, selectedDeviceId]);

  const createOutputSettings = useCallback((): AudioOutputSettings => {
    const output: AudioOutputSettings = {
      outputMode,
    };

    if (selectedDevice) {
      output.deviceIndex = selectedDevice.index;
      output.deviceName = selectedDevice.name;
    }

    return output;
  }, [outputMode, selectedDevice]);

  const applyOutputSettings = useCallback(
    async (nextOutputMode = outputMode, nextDeviceId = selectedDeviceId) => {
      const nextDevice =
        devices.find((device) => device.id === nextDeviceId && (nextOutputMode === 'asio' ? device.outputMode === 'asio' : device.outputMode === 'shared')) ?? null;
      const output: AudioOutputSettings = {
        outputMode: nextOutputMode,
      };

      if (nextDevice) {
        output.deviceIndex = nextDevice.index;
        output.deviceName = nextDevice.name;
      }

      setStatus(await window.echo.audio.setOutput(output));
    },
    [devices, outputMode, selectedDeviceId],
  );

  const handleNavClick = (key: SettingsNavKey): void => {
    setActiveSection(key);
    document.getElementById(`settings-sec-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleOutputModeChange = (nextMode: AudioOutputMode): void => {
    setOutputMode(nextMode);
    const nextDevices = devices.filter((device) => (nextMode === 'asio' ? device.outputMode === 'asio' : device.outputMode === 'shared'));
    const nextDeviceId = nextDevices.find((device) => device.isDefault)?.id ?? nextDevices[0]?.id ?? '';
    setSelectedDeviceId(nextDeviceId);
    void applyOutputSettings(nextMode, nextDeviceId);
  };

  const handleDeviceChange = (nextDeviceId: string): void => {
    setSelectedDeviceId(nextDeviceId);
    void applyOutputSettings(outputMode, nextDeviceId);
  };

  const handleOpenAndPlay = async (): Promise<void> => {
    setIsBusy(true);
    setError(null);

    try {
      const filePath = await window.echo.playback.openLocalAudioFile();

      if (!filePath) {
        return;
      }

      const output = createOutputSettings();
      setStatus(await window.echo.audio.setOutput(output));
      await window.echo.playback.playLocalFile({
        filePath,
        output,
      });
      setLastOpenedFile(filePath);
      await refreshStatus();
    } catch (playError) {
      setError(playError instanceof Error ? playError.message : String(playError));
      await refreshStatus();
    } finally {
      setIsBusy(false);
    }
  };

  const handlePause = async (): Promise<void> => {
    await window.echo.playback.pause();
    await refreshStatus();
  };

  const handleStop = async (): Promise<void> => {
    await window.echo.playback.stop();
    await refreshStatus();
  };

  const activeNavItems = visibleNavItems.length ? visibleNavItems : settingsNavItems;

  return (
    <div className="settings-page no-drag">
      <header className="settings-header">
        <h1>设置</h1>
        <label className="settings-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={settingsQuery}
            onChange={(event) => setSettingsQuery(event.target.value)}
            placeholder="搜索设置..."
          />
        </label>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="设置">
          {activeNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.key;
            const isDanger = item.key === 'danger';

            return (
              <button
                className={`settings-nav-item ${isActive ? 'active' : ''} ${isDanger ? 'is-danger' : ''}`}
                key={item.key}
                type="button"
                onClick={() => handleNavClick(item.key)}
              >
                <Icon size={17} />
                <span className="settings-nav-copy">
                  <span className="settings-nav-label">{item.label}</span>
                  <span className="settings-nav-desc">{item.description}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="settings-scroll-shell">
          <div className="settings-content">
            <SettingSection activeKey={activeSection} icon={MessageSquare} id="general" title="通用">
              <SettingRow title="显示语言" description="选择菜单、应用内设置与系统对话框的显示语言。">
                <div className="settings-chip-row">
                  <ChipButton>English</ChipButton>
                  <ChipButton active>简体中文</ChipButton>
                  <ChipButton>繁體中文（台灣）</ChipButton>
                  <ChipButton>日本語</ChipButton>
                </div>
              </SettingRow>
              <SettingRow title="关闭按钮行为" description="选择点击右上角关闭按钮时，是直接退出应用还是隐藏到系统托盘。">
                <div className="settings-chip-row">
                  <ChipButton>隐藏到托盘</ChipButton>
                  <ChipButton active>直接退出</ChipButton>
                </div>
              </SettingRow>
              <SettingRow title="设置参数备份" description="导出或导入 ECHO Next 设置参数，用于迁移到新设备或恢复配置。">
                <div className="settings-chip-row">
                  <button className="settings-action-button" type="button">
                    <Download size={15} />
                    导出设置
                  </button>
                  <button className="settings-action-button" type="button">
                    导入设置
                  </button>
                </div>
              </SettingRow>
            </SettingSection>

            <SettingSection activeKey={activeSection} icon={Zap} id="playback" title="播放与音频">
              <SettingRow title="输出模式" description="Shared 适合日常使用；Exclusive / ASIO 用于采样率验收和后续 bit-perfect 路径。">
                <div className="settings-chip-row">
                  {(['shared', 'exclusive', 'asio'] as AudioOutputMode[]).map((mode) => (
                    <ChipButton active={outputMode === mode} key={mode} onClick={() => handleOutputModeChange(mode)}>
                      {mode}
                    </ChipButton>
                  ))}
                </div>
              </SettingRow>
              <SettingRow title="输出设备" description="来自 echo-audio-host 的设备列表；没有设备时保持默认输出。">
                <label className="settings-select-field">
                  <select value={selectedDeviceId} onChange={(event) => handleDeviceChange(event.target.value)} disabled={compatibleDevices.length === 0}>
                    {compatibleDevices.length === 0 ? (
                      <option value="">无可用设备</option>
                    ) : (
                      compatibleDevices.map((device) => (
                        <option value={device.id} key={device.id}>
                          {device.index} - {device.name}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </SettingRow>
              <SettingRow title="本地音频验收" description="开发期入口，用于打开本地音频并检查 44.1k / 48k / 96k 采样率状态。">
                <div className="settings-chip-row">
                  <button className="settings-action-button" type="button" onClick={() => void handleOpenAndPlay()} disabled={!isDevBuild || isBusy || status?.host === 'unavailable'}>
                    <FileAudio size={15} />
                    打开音频
                  </button>
                  <button className="settings-icon-button" type="button" aria-label="暂停" title="暂停" onClick={() => void handlePause()}>
                    <Pause size={15} />
                  </button>
                  <button className="settings-icon-button" type="button" aria-label="停止" title="停止" onClick={() => void handleStop()}>
                    <Square size={15} />
                  </button>
                  <button className="settings-icon-button" type="button" aria-label="刷新音频状态" title="刷新音频状态" onClick={() => void refreshStatus()}>
                    <RefreshCw size={15} />
                  </button>
                </div>
              </SettingRow>
              <SettingRow title="无线播放" description="后续 HiFi 引擎阶段再接入；当前阶段不迁移 gapless / automix / 流媒体。">
                <ToggleButton />
              </SettingRow>
              <SettingRow title="定位当前播放歌曲" description="开启后，切歌时会自动把左侧当前列表滚动到正在播放的歌曲位置。">
                <ToggleButton />
              </SettingRow>
              <SettingRow title="音频状态" description="采样率字段必须分开显示，避免旧 ECHO 的独占模式 48k 锁死回归。">
                <div className="settings-status-grid">
                  {statusRows(status).map((row) => (
                    <span key={row.label}>
                      <em>{row.label}</em>
                      <strong>{row.value}</strong>
                    </span>
                  ))}
                </div>
              </SettingRow>
              {lastOpenedFile ? <p className="settings-inline-note">{lastOpenedFile}</p> : null}
              {error ? <p className="settings-inline-error">{error}</p> : null}
              {status?.warnings.length ? (
                <p className="settings-inline-error">warnings: {status.warnings.join(', ')}</p>
              ) : null}
            </SettingSection>

            <SettingSection activeKey={activeSection} icon={Link2} id="integrations" title="联动">
              <SettingRow title="Discord 状态" description="Phase 1 暂不接入联动服务，保留设置位置。">
                <ToggleButton />
              </SettingRow>
              <SettingRow title="手机遥控" description="未来外部设备能力会走受控 IPC，不让 Renderer 直连系统资源。">
                <ToggleButton />
              </SettingRow>
            </SettingSection>

            <SettingSection activeKey={activeSection} icon={Globe2} id="remote" title="网盘 / 远程">
              <SettingRow title="远程音乐库" description="本阶段禁止网盘 / 远程 / 流媒体，只保留设置分组占位。">
                <ChipButton active>未启用</ChipButton>
              </SettingRow>
            </SettingSection>

            <SettingSection activeKey={activeSection} icon={SlidersHorizontal} id="eq" title="EQ">
              <SettingRow title="均衡器" description="EQ、VST、DSD 等 HiFi 扩展不在当前 Library Core 阶段实现。">
                <ToggleButton />
              </SettingRow>
              <SettingRow title="输出安全" description="未来开启 EQ 前需要明确的增益与削波保护。">
                <ChipButton active>安全模式</ChipButton>
              </SettingRow>
            </SettingSection>

            <SettingSection activeKey={activeSection} icon={Palette} id="appearance" title="外观">
              <SettingRow title="主题" description="先保持浅色玻璃界面，后续再接入持久化主题设置。">
                <div className="settings-chip-row">
                  <ChipButton active>浅色</ChipButton>
                  <ChipButton>深色</ChipButton>
                  <ChipButton>跟随系统</ChipButton>
                </div>
              </SettingRow>
              <SettingRow title="界面密度" description="曲库列表采用更紧凑的桌面密度，不再使用过大的卡片行。">
                <div className="settings-chip-row">
                  <ChipButton active>紧凑</ChipButton>
                  <ChipButton>标准</ChipButton>
                </div>
              </SettingRow>
            </SettingSection>

            <SettingSection activeKey={activeSection} icon={Download} id="library" title="媒体库">
              <LibraryFoldersPanel />
              {isDevBuild ? <LibraryDiagnosticsPanel /> : null}
            </SettingSection>

            <SettingSection activeKey={activeSection} icon={Info} id="about" title="关于 / 高级">
              <SettingRow title="开发模式" description="当前正在使用 ECHO Next Phase 1：Library Core + Audio Host 验收。">
                <ChipButton active>{isDevBuild ? 'Dev' : 'Build'}</ChipButton>
              </SettingRow>
              <SettingRow title="原生 SQLite" description="better-sqlite3 会在 dev 前 rebuild 到 Electron ABI，避免扫描时模块版本不匹配。">
                <ChipButton active>ready</ChipButton>
              </SettingRow>
              <SettingRow title="音频宿主" description="echo-audio-host.exe 当前用于本地迁移验收，正式发布后走 extraResources。">
                <ChipButton active>{status?.host ?? 'checking'}</ChipButton>
              </SettingRow>
            </SettingSection>

            <SettingSection activeKey={activeSection} icon={Trash2} id="danger" title="危险操作">
              <SettingRow title="清空曲库缓存" description="当前不提供一键危险操作，避免误删或误清理本地扫描结果。">
                <button className="settings-danger-button" type="button" disabled>
                  暂不可用
                </button>
              </SettingRow>
            </SettingSection>

            <section className="settings-section settings-section--devices" data-visible={activeSection === 'playback'}>
              <div className="section-title">
                <Headphones size={18} />
                <h2>设备列表</h2>
              </div>
              {devices.length === 0 ? (
                <p className="settings-inline-note">echo-audio-host 暂未返回输出设备。</p>
              ) : (
                <div className="audio-device-table">
                  <div className="audio-device-row audio-device-row--head">
                    <span>name</span>
                    <span>index</span>
                    <span>sampleRate</span>
                    <span>sharedDeviceSampleRate</span>
                    <span>outputMode</span>
                  </div>
                  {devices.map((device) => (
                    <div className="audio-device-row" key={device.id}>
                      <strong>{device.name}</strong>
                      <span>{device.index}</span>
                      <span>{formatRate(device.sampleRate)}</span>
                      <span>{formatRate(device.sharedDeviceSampleRate)}</span>
                      <span>{device.outputMode}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
};
