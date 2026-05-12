// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AudioStatus } from '../../../shared/types/audio';
import type { EqPreset, EqState } from '../../../shared/types/eq';
import { EqPanel } from './EqPanel';

const bands = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequencyHz) => ({
  frequencyHz,
  gainDb: 0,
  q: 1,
}));

const eqState = (overrides: Partial<EqState> = {}): EqState => ({
  enabled: false,
  preampDb: 0,
  bands,
  presetId: 'flat',
  presetName: 'Flat',
  clippingRisk: false,
  ...overrides,
});

const presets: EqPreset[] = [
  { id: 'flat', name: 'Flat', preampDb: 0, bands, createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'rock', name: 'Rock', preampDb: -3, bands, createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
];

const audioStatus: AudioStatus = {
  host: 'ready',
  state: 'playing',
  outputDeviceId: null,
  outputDeviceName: null,
  outputDeviceType: null,
  outputBackend: 'wasapi-exclusive',
  outputMode: 'exclusive',
  volume: 1,
  playbackRate: 1,
  playbackSpeedMode: 'nightcore',
  currentFilePath: null,
  currentTrackId: null,
  durationSeconds: 0,
  positionSeconds: 0,
  channels: 2,
  codec: 'FLAC',
  bitDepth: 24,
  bitrate: 1400000,
  fileSampleRate: 44100,
  decoderOutputSampleRate: 44100,
  requestedOutputSampleRate: 44100,
  actualDeviceSampleRate: 44100,
  sharedDeviceSampleRate: null,
  resampling: false,
  bitPerfectCandidate: false,
  sampleRateMismatch: false,
  eqEnabled: true,
  channelBalanceEnabled: false,
  dspActive: true,
  preampDb: 0,
  eqPresetName: 'Flat',
  clippingRisk: false,
  bitPerfectDisabledReason: 'eq_enabled',
  warnings: ['eq_enabled_bit_perfect_disabled'],
  error: null,
};

beforeEach(() => {
  const currentState = eqState();
  window.echo = {
    eq: {
      getState: vi.fn().mockResolvedValue(currentState),
      listPresets: vi.fn().mockResolvedValue(presets),
      setEnabled: vi.fn().mockImplementation((enabled: boolean) => Promise.resolve(eqState({ enabled }))),
      setBandGain: vi.fn().mockImplementation(({ band, gainDb }: { band: number; gainDb: number }) =>
        Promise.resolve(eqState({ presetId: 'custom', presetName: 'Custom', bands: bands.map((item, index) => (index === band ? { ...item, gainDb } : item)) })),
      ),
      setBandFrequency: vi.fn().mockImplementation(({ band, frequencyHz }: { band: number; frequencyHz: number }) =>
        Promise.resolve(eqState({ presetId: 'custom', presetName: 'Custom', bands: bands.map((item, index) => (index === band ? { ...item, frequencyHz } : item)) })),
      ),
      setPreamp: vi.fn().mockImplementation((preampDb: number) => Promise.resolve(eqState({ preampDb }))),
      setPreset: vi.fn().mockImplementation((presetId: string) => Promise.resolve(eqState({ presetId, presetName: presetId }))),
      reset: vi.fn().mockResolvedValue(currentState),
      savePreset: vi.fn().mockResolvedValue(presets[0]),
      deletePreset: vi.fn().mockResolvedValue(presets),
      getChannelBalanceState: vi.fn().mockResolvedValue({
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
      }),
      setChannelBalanceState: vi.fn().mockImplementation((patch) =>
        Promise.resolve({
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
          ...patch,
        }),
      ),
      resetChannelBalance: vi.fn().mockResolvedValue({
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
      }),
    },
  } as unknown as Window['echo'];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EqPanel', () => {
  it('renders the parametric-style EQ editor', async () => {
    render(<EqPanel audioStatus={audioStatus} />);

    await screen.findByRole('img', { name: 'Draggable parametric EQ curve' });
    expect(screen.getByText('参数化 EQ')).toBeTruthy();
    expect(screen.getByText('Band 1')).toBeTruthy();
  });

  it('sends band gain changes to the EQ bridge', async () => {
    render(<EqPanel audioStatus={audioStatus} />);

    const node = await screen.findByTestId('eq-curve-node-2');
    fireEvent.pointerDown(node, { clientY: 198, pointerId: 1 });
    const gainInput = await screen.findByLabelText('Selected EQ band gain');
    fireEvent.change(gainInput, { target: { value: '3.5' } });
    fireEvent.blur(gainInput);

    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 2, gainDb: 3.5 }));
  });

  it('lets the EQ curve nodes update band gain directly', async () => {
    render(<EqPanel audioStatus={audioStatus} />);

    const curve = await screen.findByRole('img', { name: 'Draggable parametric EQ curve' });
    curve.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1180,
      bottom: 390,
      width: 1180,
      height: 390,
      toJSON: () => undefined,
    }));

    const node = await screen.findByTestId('eq-curve-node-2');
    fireEvent.pointerDown(node, { clientX: 392, clientY: 146, pointerId: 1 });
    fireEvent.pointerMove(curve, { clientX: 392, clientY: 146, pointerId: 1 });
    fireEvent.pointerUp(curve, { clientX: 392, clientY: 146, pointerId: 1 });

    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 2, gainDb: 4 }));
    await waitFor(() => expect(window.echo.eq.setBandFrequency).toHaveBeenCalledWith({ band: 2, frequencyHz: expect.any(Number) }));
  });

  it('edits the selected band frequency from the precision controls', async () => {
    render(<EqPanel audioStatus={audioStatus} />);

    const node = await screen.findByTestId('eq-curve-node-2');
    fireEvent.pointerDown(node, { clientX: 392, clientY: 198, pointerId: 1 });
    const frequencyInput = await screen.findByLabelText('Selected EQ band frequency');
    fireEvent.change(frequencyInput, { target: { value: '410' } });
    fireEvent.blur(frequencyInput);

    await waitFor(() => expect(window.echo.eq.setBandFrequency).toHaveBeenCalledWith({ band: 2, frequencyHz: 410 }));
  });

  it('selects presets, resets to Flat, and shows the bit-perfect warning', async () => {
    render(<EqPanel audioStatus={audioStatus} />);

    fireEvent.change(await screen.findByLabelText('EQ preset'), { target: { value: 'rock' } });
    fireEvent.click(screen.getByRole('button', { name: '重置 EQ' }));

    await waitFor(() => expect(window.echo.eq.setPreset).toHaveBeenCalledWith('rock'));
    expect(window.echo.eq.reset).toHaveBeenCalled();
    expect(screen.getByText(/不再是 bit-perfect/i)).toBeTruthy();
  });
});
