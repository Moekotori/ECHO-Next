import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Save, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { AudioStatus, ChannelBalanceMonoMode, ChannelBalanceState } from '../../../shared/types/audio';
import { channelBalanceMaxGainDb, channelBalanceMinGainDb } from '../../../shared/types/audio';
import type { EqPreset, EqState } from '../../../shared/types/eq';
import { eqMaxFrequencyHz, eqMinFrequencyHz } from '../../../shared/types/eq';
import { getEqBridge } from '../../utils/echoBridge';
import { EqCurveView } from './EqCurveView';
import { EqPresetSelector } from './EqPresetSelector';

type EqPanelProps = {
  audioStatus: AudioStatus | null;
  onAudioStatusRefresh?: () => void;
};

const fallbackState: EqState = {
  enabled: false,
  preampDb: 0,
  presetId: 'flat',
  presetName: 'Flat',
  clippingRisk: false,
  bands: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequencyHz) => ({
    frequencyHz,
    gainDb: 0,
    q: 1,
  })),
};

const formatFrequency = (frequencyHz: number): string =>
  frequencyHz >= 1000 ? `${frequencyHz / 1000} kHz` : `${frequencyHz} Hz`;

const formatGain = (gainDb: number): string => `${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)} dB`;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const fallbackChannelBalanceState: ChannelBalanceState = {
  enabled: false,
  balance: 0,
  leftGainDb: 0,
  rightGainDb: 0,
  swapLeftRight: false,
  monoMode: 'off',
  invertLeft: false,
  invertRight: false,
  constantPower: true,
  clippingRisk: false,
};

const monoModeOptions: Array<{ value: ChannelBalanceMonoMode; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'sum', label: 'L+R 单声道' },
  { value: 'left', label: '仅左声道' },
  { value: 'right', label: '仅右声道' },
];

const calculateBalanceGains = (balance: number, constantPower: boolean): { left: number; right: number } => {
  const safeBalance = clamp(balance, -1, 1);

  if (!constantPower) {
    return {
      left: safeBalance > 0 ? 1 - safeBalance : 1,
      right: safeBalance < 0 ? 1 + safeBalance : 1,
    };
  }

  const pan = (safeBalance + 1) * Math.PI * 0.25;
  const compensation = Math.sqrt(2);
  return {
    left: Math.min(1, Math.cos(pan) * compensation),
    right: Math.min(1, Math.sin(pan) * compensation),
  };
};

const gainToDb = (gain: number): number => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);

export const EqPanel = ({ audioStatus, onAudioStatusRefresh }: EqPanelProps): JSX.Element => {
  const [state, setState] = useState<EqState>(fallbackState);
  const [channelBalance, setChannelBalance] = useState<ChannelBalanceState>(fallbackChannelBalanceState);
  const [presets, setPresets] = useState<EqPreset[]>([]);
  const [saveName, setSaveName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedBandIndex, setSelectedBandIndex] = useState(0);
  const debounceTimers = useRef<Record<number, number>>({});
  const frequencyDebounceTimers = useRef<Record<number, number>>({});

  const selectedBand = state.bands[selectedBandIndex] ?? state.bands[0];
  const selectedPresetReadonly = presets.find((preset) => preset.id === state.presetId)?.readonly ?? true;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const eq = getEqBridge();

      if (!eq) {
        setPresets([]);
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
        return;
      }

      const [nextState, nextPresets, nextChannelBalance] = await Promise.all([eq.getState(), eq.listPresets(), eq.getChannelBalanceState()]);
      setState(nextState);
      setPresets(nextPresets);
      setChannelBalance(nextChannelBalance);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const commitState = useCallback(
    (nextState: EqState): void => {
      setState(nextState);
      onAudioStatusRefresh?.();
    },
    [onAudioStatusRefresh],
  );

  const commitChannelBalance = useCallback(
    (nextState: ChannelBalanceState): void => {
      setChannelBalance(nextState);
      onAudioStatusRefresh?.();
    },
    [onAudioStatusRefresh],
  );

  const patchChannelBalance = (patch: Partial<ChannelBalanceState>): void => {
    const eq = getEqBridge();
    setChannelBalance((current) => ({ ...current, ...patch }));

    if (!eq) {
      setError('Desktop bridge unavailable. Open ECHO Next in Electron to control channel balance.');
      return;
    }

    void eq.setChannelBalanceState(patch).then(commitChannelBalance).catch((balanceError: unknown) => {
      setError(balanceError instanceof Error ? balanceError.message : String(balanceError));
    });
  };

  const resetChannelBalance = (): void => {
    const eq = getEqBridge();

    if (!eq) {
      setChannelBalance(fallbackChannelBalanceState);
      setError('Desktop bridge unavailable. Open ECHO Next in Electron to control channel balance.');
      return;
    }

    void eq.resetChannelBalance().then(commitChannelBalance).catch((balanceError: unknown) => {
      setError(balanceError instanceof Error ? balanceError.message : String(balanceError));
    });
  };

  const setEnabled = (enabled: boolean): void => {
    const eq = getEqBridge();
    setState((current) => ({ ...current, enabled }));

    if (!eq) {
      setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
      return;
    }

    void eq.setEnabled(enabled).then(commitState).catch((toggleError: unknown) => {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    });
  };

  const sendBandGain = useCallback(
    (band: number, gainDb: number): void => {
      const eq = getEqBridge();

      if (!eq) {
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
        return;
      }

      void eq.setBandGain({ band, gainDb }).then(commitState).catch((bandError: unknown) => {
        setError(bandError instanceof Error ? bandError.message : String(bandError));
      });
    },
    [commitState],
  );

  const handleBandChange = (band: number, gainDb: number): void => {
    setSelectedBandIndex(band);
    setState((current) => ({
      ...current,
      presetId: 'custom',
      presetName: 'Custom',
      bands: current.bands.map((item, index) => (index === band ? { ...item, gainDb } : item)),
    }));

    window.clearTimeout(debounceTimers.current[band]);
    debounceTimers.current[band] = window.setTimeout(() => sendBandGain(band, gainDb), 45);
  };

  const handleBandCommit = (band: number, gainDb: number): void => {
    setSelectedBandIndex(band);
    window.clearTimeout(debounceTimers.current[band]);
    sendBandGain(band, gainDb);
  };

  const sendBandFrequency = useCallback(
    (band: number, frequencyHz: number): void => {
      const eq = getEqBridge();

      if (!eq) {
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
        return;
      }

      void eq.setBandFrequency({ band, frequencyHz }).then(commitState).catch((bandError: unknown) => {
        setError(bandError instanceof Error ? bandError.message : String(bandError));
      });
    },
    [commitState],
  );

  const handleBandFrequencyChange = (band: number, frequencyHz: number): void => {
    const safeFrequencyHz = clamp(Number(frequencyHz), eqMinFrequencyHz, eqMaxFrequencyHz);
    setSelectedBandIndex(band);
    setState((current) => ({
      ...current,
      presetId: 'custom',
      presetName: 'Custom',
      bands: current.bands.map((item, index) => (index === band ? { ...item, frequencyHz: safeFrequencyHz } : item)),
    }));

    window.clearTimeout(frequencyDebounceTimers.current[band]);
    frequencyDebounceTimers.current[band] = window.setTimeout(() => sendBandFrequency(band, safeFrequencyHz), 45);
  };

  const handleBandFrequencyCommit = (band: number, frequencyHz: number): void => {
    const safeFrequencyHz = clamp(Number(frequencyHz), eqMinFrequencyHz, eqMaxFrequencyHz);
    setSelectedBandIndex(band);
    window.clearTimeout(frequencyDebounceTimers.current[band]);
    sendBandFrequency(band, safeFrequencyHz);
  };

  const handlePreampChange = (preampDb: number): void => {
    const eq = getEqBridge();
    setState((current) => ({ ...current, preampDb, presetId: 'custom', presetName: 'Custom' }));

    if (!eq) {
      setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
      return;
    }

    void eq.setPreamp(preampDb).then(commitState).catch((preampError: unknown) => {
      setError(preampError instanceof Error ? preampError.message : String(preampError));
    });
  };

  const setPreset = (presetId: string): void => {
    const eq = getEqBridge();

    if (!eq) {
      setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
      return;
    }

    void eq.setPreset(presetId).then(commitState).catch((presetError: unknown) => {
      setError(presetError instanceof Error ? presetError.message : String(presetError));
    });
  };

  const reset = (): void => {
    const eq = getEqBridge();

    if (!eq) {
      setState(fallbackState);
      setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
      return;
    }

    void eq.reset().then(commitState).catch((resetError: unknown) => {
      setError(resetError instanceof Error ? resetError.message : String(resetError));
    });
  };

  const savePreset = async (): Promise<void> => {
    if (!saveName.trim()) {
      setError('请输入预设名称');
      return;
    }

    try {
      const eq = getEqBridge();

      if (!eq) {
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to save EQ presets.');
        return;
      }

      await eq.savePreset({
        name: saveName,
        preampDb: state.preampDb,
        bands: state.bands,
      });
      setSaveName('');
      setPresets(await eq.listPresets());
      setError(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  };

  const deletePreset = async (): Promise<void> => {
    try {
      const eq = getEqBridge();

      if (!eq) {
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to delete EQ presets.');
        return;
      }

      setPresets(await eq.deletePreset(state.presetId));
      await reset();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const bitPerfectText =
    state.enabled || channelBalance.enabled || audioStatus?.dspActive
      ? 'DSP 已启用，当前输出不再是 bit-perfect。'
      : 'DSP 已旁路，满足采样率与输出条件时可恢复 bit-perfect。';
  const balanceGains = calculateBalanceGains(channelBalance.balance, channelBalance.constantPower);
  const leftTotalDb = channelBalance.leftGainDb + gainToDb(balanceGains.left);
  const rightTotalDb = channelBalance.rightGainDb + gainToDb(balanceGains.right);
  const channelBalanceRisk = leftTotalDb > 0 || rightTotalDb > 0 || Boolean(channelBalance.clippingRisk);

  return (
    <section className="eq-panel" aria-label="ECHO Next EQ panel" data-enabled={state.enabled}>
      <header className="eq-compact-header">
        <div className="eq-title-block">
          <span className="eq-title-icon">
            <SlidersHorizontal size={18} />
          </span>
          <div>
            <h2>参数化 EQ</h2>
            <p>10-band graphic engine</p>
          </div>
          <strong>{state.enabled ? '已启用' : '旁路'}</strong>
        </div>

        <div className="eq-compact-actions">
          <label className="eq-enable-pill">
            <input type="checkbox" checked={state.enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} />
            <span>{state.enabled ? 'On' : 'Bypass'}</span>
          </label>
          <EqPresetSelector presets={presets} value={state.presetId} onChange={setPreset} />
          <button className="eq-icon-action" type="button" aria-label="重置 EQ" title="重置 EQ" onClick={reset}>
            <RotateCcw size={15} />
          </button>
        </div>
      </header>

      <div className="eq-compact-editor">
        <aside className="eq-preamp-strip">
          <span>Preamp</span>
          <strong>{formatGain(state.preampDb)}</strong>
          <input
            aria-label="EQ preamp"
            type="range"
            min="-12"
            max="6"
            step="0.1"
            value={state.preampDb}
            onChange={(event) => handlePreampChange(Number(event.currentTarget.value))}
          />
        </aside>

        <div className="eq-curve-column">
          <EqCurveView
            bands={state.bands}
            enabled={state.enabled}
            selectedBandIndex={selectedBandIndex}
            onBandSelect={setSelectedBandIndex}
            onBandChange={handleBandChange}
            onBandCommit={handleBandCommit}
            onBandFrequencyChange={handleBandFrequencyChange}
            onBandFrequencyCommit={handleBandFrequencyCommit}
          />

          <div className="eq-band-compact">
            <button className="eq-band-name" type="button">
              Band {selectedBandIndex + 1}
              <strong>{selectedBand ? formatFrequency(selectedBand.frequencyHz) : 'n/a'}</strong>
            </button>
            <label>
              <span>Freq</span>
              <input
                aria-label="Selected EQ band frequency"
                type="number"
                min={eqMinFrequencyHz}
                max={eqMaxFrequencyHz}
                step="1"
                value={Math.round(selectedBand?.frequencyHz ?? 0)}
                onChange={(event) => handleBandFrequencyChange(selectedBandIndex, Number(event.currentTarget.value))}
                onBlur={(event) => handleBandFrequencyCommit(selectedBandIndex, Number(event.currentTarget.value))}
              />
              <em>Hz</em>
            </label>
            <label>
              <span>Gain</span>
              <input
                aria-label="Selected EQ band gain"
                type="number"
                min="-12"
                max="12"
                step="0.1"
                value={selectedBand?.gainDb ?? 0}
                onChange={(event) => handleBandChange(selectedBandIndex, Number(event.currentTarget.value))}
                onBlur={(event) => handleBandCommit(selectedBandIndex, Number(event.currentTarget.value))}
              />
              <em>dB</em>
            </label>
            <label>
              <span>Q</span>
              <input value={selectedBand?.q.toFixed(2) ?? '1.00'} readOnly />
            </label>
            <span className="eq-param-chip">Bell</span>
            <span className="eq-param-chip">L/R linked</span>
            <span className="eq-param-chip">Minimum phase</span>
            <button className="eq-soft-button" type="button" onClick={() => handleBandCommit(selectedBandIndex, 0)}>
              归零
            </button>
          </div>
        </div>
      </div>

      <div className="eq-status-line" data-risk={state.clippingRisk || audioStatus?.clippingRisk}>
        <strong>{state.clippingRisk || audioStatus?.clippingRisk ? 'Headroom' : 'Signal'}</strong>
        <span>{state.clippingRisk || audioStatus?.clippingRisk ? '有削波风险，建议降低前级或减少提升频段。' : bitPerfectText}</span>
      </div>


      <section className="channel-balance-panel" aria-label="Channel balance panel" data-enabled={channelBalance.enabled}>
        <header className="channel-balance-header">
          <div>
            <h3>声道平衡</h3>
            <p>用于修正耳机、音箱或听力造成的左右偏音。播放中调整会平滑生效。</p>
          </div>
          <div className="channel-balance-actions">
            <label className="eq-enable-pill">
              <input
                type="checkbox"
                checked={channelBalance.enabled}
                onChange={(event) => patchChannelBalance({ enabled: event.currentTarget.checked })}
              />
              <span>{channelBalance.enabled ? 'On' : 'Bypass'}</span>
            </label>
            <button className="eq-icon-action" type="button" aria-label="重置声道平衡" title="重置声道平衡" onClick={resetChannelBalance}>
              <RotateCcw size={15} />
            </button>
          </div>
        </header>

        <div className="channel-balance-grid">
          <label className="channel-balance-wide">
            <span>Balance</span>
            <input
              aria-label="Channel balance"
              type="range"
              min="-100"
              max="100"
              step="1"
              value={Math.round(channelBalance.balance * 100)}
              onChange={(event) => patchChannelBalance({ balance: Number(event.currentTarget.value) / 100 })}
            />
            <strong>
              {channelBalance.balance < 0 ? '左' : channelBalance.balance > 0 ? '右' : '中间'} {Math.round(Math.abs(channelBalance.balance) * 100)}
            </strong>
          </label>
          <label>
            <span>Left Gain</span>
            <input
              type="range"
              min={channelBalanceMinGainDb}
              max={channelBalanceMaxGainDb}
              step="0.1"
              value={channelBalance.leftGainDb}
              onChange={(event) => patchChannelBalance({ leftGainDb: Number(event.currentTarget.value) })}
            />
            <strong>{formatGain(channelBalance.leftGainDb)}</strong>
          </label>
          <label>
            <span>Right Gain</span>
            <input
              type="range"
              min={channelBalanceMinGainDb}
              max={channelBalanceMaxGainDb}
              step="0.1"
              value={channelBalance.rightGainDb}
              onChange={(event) => patchChannelBalance({ rightGainDb: Number(event.currentTarget.value) })}
            />
            <strong>{formatGain(channelBalance.rightGainDb)}</strong>
          </label>
          <label>
            <span>Mono 模式</span>
            <select
              value={channelBalance.monoMode}
              onChange={(event) => patchChannelBalance({ monoMode: event.currentTarget.value as ChannelBalanceMonoMode })}
            >
              {monoModeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="channel-balance-switches">
            <button
              className={`eq-soft-button ${channelBalance.swapLeftRight ? 'active' : ''}`}
              type="button"
              onClick={() => patchChannelBalance({ swapLeftRight: !channelBalance.swapLeftRight })}
            >
              Swap L/R
            </button>
            <button
              className={`eq-soft-button ${channelBalance.invertLeft ? 'active' : ''}`}
              type="button"
              onClick={() => patchChannelBalance({ invertLeft: !channelBalance.invertLeft })}
            >
              Invert Left
            </button>
            <button
              className={`eq-soft-button ${channelBalance.invertRight ? 'active' : ''}`}
              type="button"
              onClick={() => patchChannelBalance({ invertRight: !channelBalance.invertRight })}
            >
              Invert Right
            </button>
            <button
              className={`eq-soft-button ${channelBalance.constantPower ? 'active' : ''}`}
              type="button"
              onClick={() => patchChannelBalance({ constantPower: !channelBalance.constantPower })}
            >
              Constant Power
            </button>
          </div>
        </div>

        <div className="channel-balance-readout" data-risk={channelBalanceRisk}>
          <span>
            <em>左声道总增益</em>
            <strong>{Number.isFinite(leftTotalDb) ? formatGain(leftTotalDb) : '-inf dB'}</strong>
          </span>
          <span>
            <em>右声道总增益</em>
            <strong>{Number.isFinite(rightTotalDb) ? formatGain(rightTotalDb) : '-inf dB'}</strong>
          </span>
          {channelBalanceRisk ? <p>增益高于 0 dB 时可能增加削波风险。</p> : null}
        </div>
      </section>
      <footer className="eq-preset-tools">
        <input
          aria-label="Preset name"
          value={saveName}
          onChange={(event) => setSaveName(event.currentTarget.value)}
          placeholder="保存为新预设"
        />
        <button type="button" onClick={() => void savePreset()}>
          <Save size={15} />
          保存
        </button>
        {!selectedPresetReadonly ? (
          <button type="button" onClick={() => void deletePreset()}>
            <Trash2 size={15} />
            删除
          </button>
        ) : null}
      </footer>
      {error ? <p className="eq-panel-error">{error}</p> : null}
    </section>
  );
};
