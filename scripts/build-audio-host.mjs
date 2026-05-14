import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const sourceDir = join(projectRoot, 'native', 'audio-host');
const buildDir = join(projectRoot, 'out', 'native', 'audio-host');
const targetDir = join(projectRoot, 'electron-app', 'build');
const targetExe = join(targetDir, process.platform === 'win32' ? 'echo-audio-host.exe' : 'echo-audio-host');
const packagedResourceExe = join(
  projectRoot,
  'dist',
  'win-unpacked',
  'resources',
  process.platform === 'win32' ? 'echo-audio-host.exe' : 'echo-audio-host',
);
const config = process.env.ECHO_AUDIO_HOST_CONFIG || 'Release';
const enableAsio = process.env.ECHO_ENABLE_ASIO ?? (process.platform === 'win32' ? 'ON' : 'OFF');
const pngSignature = '89504e470d0a1a0a';

const walkFiles = (directory, predicate, files = []) => {
  if (!existsSync(directory)) {
    return files;
  }

  for (const name of readdirSync(directory)) {
    const filePath = join(directory, name);
    const stats = statSync(filePath);

    if (stats.isDirectory()) {
      walkFiles(filePath, predicate, files);
    } else if (predicate(filePath)) {
      files.push(filePath);
    }
  }

  return files;
};

const stripPngIccpProfile = (filePath) => {
  const data = readFileSync(filePath);

  if (data.length < 8 || data.toString('hex', 0, 8) !== pngSignature) {
    return false;
  }

  const chunks = [data.subarray(0, 8)];
  let offset = 8;
  let stripped = false;

  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const nextOffset = offset + 12 + length;

    if (nextOffset > data.length) {
      return false;
    }

    const type = data.toString('ascii', offset + 4, offset + 8);

    if (type === 'iCCP') {
      stripped = true;
    } else {
      chunks.push(data.subarray(offset, nextOffset));
    }

    offset = nextOffset;
  }

  if (stripped) {
    writeFileSync(filePath, Buffer.concat(chunks));
  }

  return stripped;
};

const stripJuceExamplePngProfiles = () => {
  const juceDir = join(buildDir, '_deps', 'juce-src');
  const pngFiles = walkFiles(juceDir, (filePath) => filePath.toLocaleLowerCase().endsWith('.png'));
  const strippedCount = pngFiles.filter(stripPngIccpProfile).length;

  if (strippedCount > 0) {
    console.log(`[build:audio-host] Stripped invalid PNG iCCP profiles from ${strippedCount} JUCE example asset(s).`);
  }
};

const patchJuceWasapiExclusiveProbe = () => {
  if (process.platform !== 'win32') {
    return;
  }

  const wasapiSource = join(
    buildDir,
    '_deps',
    'juce-src',
    'modules',
    'juce_audio_devices',
    'native',
    'juce_WASAPI_windows.cpp',
  );

  if (!existsSync(wasapiSource)) {
    throw new Error(`JUCE WASAPI source was not found at ${wasapiSource}`);
  }

  const source = readFileSync(wasapiSource, 'utf8');
  const patchedNeedle = 'ECHO-Next fast exclusive open';

  if (source.includes(patchedNeedle)) {
    return;
  }

  const needle = [
    '        querySupportedBufferSizes (*format, tempClient);',
    '        querySupportedSampleRates (*format, tempClient);',
    '        maxNumChannels = queryMaxNumChannels (tempClient);',
  ].join('\r\n');

  const replacement = [
    '        querySupportedBufferSizes (*format, tempClient);',
    '',
    '        // ECHO-Next fast exclusive open:',
    '        // Some USB DACs take many seconds to answer JUCE\'s exhaustive exclusive-mode',
    '        // IsFormatSupported scan during createDevice(). Skip that preflight here; the',
    '        // requested sample rate/channel format is still validated by openClient().',
    '        if (isExclusiveMode (deviceMode))',
    '        {',
    '            maxNumChannels = defaultNumChannels;',
    '            return;',
    '        }',
    '',
    '        querySupportedSampleRates (*format, tempClient);',
    '        maxNumChannels = queryMaxNumChannels (tempClient);',
  ].join('\r\n');

  if (!source.includes(needle)) {
    throw new Error('Unable to patch JUCE WASAPI exclusive probe; source layout changed.');
  }

  writeFileSync(wasapiSource, source.replace(needle, replacement));
  console.log('[build:audio-host] Patched JUCE WASAPI exclusive preflight for fast device open.');
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
};

const findBuiltHost = () => {
  const exe = process.platform === 'win32' ? 'echo-audio-host.exe' : 'echo-audio-host';
  const candidates = [
    join(buildDir, 'echo-audio-host_artefacts', config, exe),
    join(buildDir, 'echo-audio-host_artefacts', exe),
    join(buildDir, config, exe),
    join(buildDir, exe),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

let cmakeGenerator;
let cmakeArchArgs;

if (isWindows) {
  cmakeGenerator = 'Visual Studio 17 2022';
  cmakeArchArgs = ['-A', 'x64'];
} else if (isLinux) {
  const ninjaCheck = spawnSync('ninja', ['--version'], { stdio: 'ignore' });
  if (ninjaCheck.status === 0 && !ninjaCheck.error) {
    cmakeGenerator = 'Ninja';
  } else {
    cmakeGenerator = 'Unix Makefiles';
  }
  cmakeArchArgs = [];
} else {
  cmakeGenerator = 'Unix Makefiles';
  cmakeArchArgs = [];
}

try {
  run('cmake', [
    '-S',
    sourceDir,
    '-B',
    buildDir,
    '-G',
    cmakeGenerator,
    ...cmakeArchArgs,
    '-DECHO_ENABLE_ASIO=' + enableAsio,
  ]);
  patchJuceWasapiExclusiveProbe();
  stripJuceExamplePngProfiles();
  run('cmake', ['--build', buildDir, '--config', config, '--parallel']);

  const builtHost = findBuiltHost();

  if (!builtHost) {
    throw new Error(`Built host binary was not found under ${buildDir}`);
  }

  mkdirSync(targetDir, { recursive: true });
  copyFileSync(builtHost, targetExe);
  console.log(`[build:audio-host] Copied ${builtHost}`);
  console.log(`[build:audio-host]      -> ${targetExe}`);

  if (existsSync(packagedResourceExe)) {
    copyFileSync(builtHost, packagedResourceExe);
    console.log(`[build:audio-host]      -> ${packagedResourceExe}`);
  }
} catch (error) {
  console.error('[build:audio-host] Failed to build JUCE audio host.');
  const platformReqs = isWindows
    ? 'Visual Studio 2022 Build Tools, Windows SDK'
    : isLinux
      ? 'build-essential, libasound2-dev, libjack-dev, and ninja-build (optional)'
      : 'Xcode Command Line Tools';
  console.error('[build:audio-host] Requirements: CMake, ' + platformReqs + ', and network access for JUCE 8.0.12.');
  console.error(`[build:audio-host] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
