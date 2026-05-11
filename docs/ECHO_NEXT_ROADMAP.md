# ECHO Next Roadmap

## Phase 0: Skeleton

- Electron + React + TypeScript + Vite
- electron-vite build pipeline
- typed preload API
- main IPC registration
- empty UI shell
- architecture and rule documents

Phase 0 intentionally kept scanning, playback, and SQLite out of the shell.

## Phase 1: Library Core

- SQLite schema and migrations for folders, tracks, albums, album tracks, artists, covers, and scan jobs
- local library folders
- background scan jobs with status, phase, cancellation, progress, and errors
- incremental scanning by `path + size_bytes + mtime_ms`
- embedded metadata reading with per-field source tracking
- persisted cover cache files for thumb, large, and original
- transaction-backed scan writes
- album grouping by album title, album artist/folder fallback, and year
- persisted album wall data that survives restart
- `SongsPage` with paged API reads and virtualized rows
- `AlbumsPage` with paged album-wall reads from SQLite
- focused tests for migration, scanning, metadata priority, cover priority, album grouping, restart persistence, pagination, and scan errors

Deferred beyond the minimal Phase 1 loop:

- FTS-backed search
- real image resizing for thumbnail variants
- manual metadata editing
- sidecar metadata
- network completion
- artist detail pages
- full file management
- lyrics, MV, streaming, and downloaders

## Phase 2: Audio Core

- local file playback
- `AudioSession` state machine
- device listing
- native output bridge inspired by `echo-audio-host`
- position events from output-side timing
- play, pause, seek, stop, next, previous
- ended and error events

## Phase 3: HiFi

- WASAPI Exclusive
- ASIO
- bit-perfect output path
- sample-rate switching
- gapless playback
- output format verification

## Phase 4: Experience

- lyrics
- MV
- streaming
- downloader
- Last.fm
- Discord RPC
- plugins

Experience features wait until the library and audio cores are stable.
