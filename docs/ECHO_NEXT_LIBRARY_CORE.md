# ECHO Next Library Core

Library Core v0.1 fixes the old ECHO library pain points by making SQLite the source of truth and by keeping heavy work behind native-worker-ready interfaces. Restarting the app reads folders, tracks, albums, artists, covers, and scan jobs directly from SQLite. It does not reparse every song, regenerate every cover, or regroup the album wall in Renderer memory.

## Modules

`LibraryService`

- public facade used by IPC
- composes `LibraryStore`, `ScanJobQueue`, workers, and album grouping
- depends on worker interfaces, not concrete TS implementations

`LibraryStore`

- owns all SQLite reads and writes
- runs paged track, album, album-track, folder, scan-job, and summary queries
- writes scan results in transactions
- persists album, artist, and cover cache rows

`ScanJobQueue`

- backgrounds scan jobs
- reports progress, phases, cancellation, and collected warnings/errors
- enforces metadata and cover worker concurrency limits
- orchestrates scanner, metadata reader, cover extractor, and SQLite writes

`MetadataReader`

- stable worker interface for tag parsing
- TS v0.1 implementation: `TsMetadataReader`
- future replacement: `RustMetadataWorker` or C++ equivalent

`CoverExtractor`

- stable worker interface for cover extraction and cache file generation
- TS v0.1 implementation: `TsCoverExtractor`
- highest-priority future native worker

`FileScanner`

- stable worker interface for file enumeration and stat data
- TS v0.1 implementation: `TsFileScanner`
- Rust/C++ only if pressure tests prove it is needed

`AlbumService`

- owns `album_key` generation
- prevents empty album values from collapsing into one huge Unknown Album

## SQLite Schema

Core tables:

- `folders`: `id`, `path`, `enabled`, `last_scan_at`, timestamps
- `tracks`: path fingerprint, normalized metadata, `genre`, `metadata_status`, `field_sources_json`, `cover_id`, `missing`, timestamps
- `albums`: persisted album-wall records with `album_key`, title, artist, year, cover, count, duration
- `album_tracks`: persisted track order with disc/track numbers
- `artists`: persisted artist counts
- `covers`: `source_type`, `thumb_path`, `large_path`, `original_ref`, hash and MIME metadata
- `scan_jobs`: status, phase, discovered/parsed/skipped/cover counts, errors, timestamps

Important indexes:

- `folders(path)`
- `tracks(path)`
- `tracks(folder_id)`
- `tracks(title)`
- `tracks(artist)`
- `tracks(album)`
- `albums(album_key)`
- `album_tracks(album_id)`
- `album_tracks(track_id)`
- `covers(id)`

Migrations are repeatable and use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and guarded `ALTER TABLE ADD COLUMN`.

## Scan Pipeline

1. `library.scanFolder(folderId)` creates a `scan_jobs` row and returns immediately.
2. `ScanJobQueue` runs in the background.
3. `discovering`: `FileScanner` emits `path`, `sizeBytes`, and `mtimeMs`.
4. `checking_cache`: `LibraryStore` compares each file against persisted `path + size_bytes + mtime_ms`.
5. Unchanged files are skipped. Metadata and cover workers are not called for them.
6. `reading_metadata`: changed/new files go through `MetadataReader`.
7. `extracting_covers`: changed/new files go through `CoverExtractor`.
8. `grouping_albums`: `AlbumService` rebuilds persisted albums from track rows.
9. `writing_database`: tracks, covers, albums, artists, folders, and scan status are committed through SQLite.
10. Final phase becomes `finished`, `failed`, or `cancelled`.

Per-file worker warnings/errors are collected in `scan_jobs.errors_json`; they do not fail the whole scan.

Deletion policy: when a file disappears from a scanned folder, the next scan marks its track row `missing = 1`. List APIs filter missing tracks out, preserving history while avoiding disk deletion. Library Core never deletes user audio files.

## Cache Strategy

The incremental key is:

- `path`
- `size_bytes`
- `mtime_ms`

When all three match, ECHO Next trusts SQLite metadata and cover links. This avoids the old restart behavior where the whole library was parsed again.

Covers are cached on disk and deduplicated by `sourceHash`. `getTracks` and `getAlbums` return only `coverThumb` file URLs. They never return full cover binary or base64 payloads.

Albums are persisted in `albums` and `album_tracks`, so the album wall reads cached rows after restart instead of regrouping all tracks in Renderer memory.

## Metadata Priority

Fixed priority:

1. manual
2. embedded
3. sidecar/info
4. folder inference
5. network completion
6. filename fallback

Phase v0.1 implements embedded, folder inference, and filename fallback. Filename guessing only fills missing fields. Embedded `title`, `artist`, and `album` are never overwritten, which prevents valid files from being stuck as Unknown Artist.

Every stored track writes `field_sources_json` for title, artist, album, albumArtist, trackNo, discNo, year, genre, duration, codec, sampleRate, bitDepth, and bitrate.

## Cover Priority

Phase v0.1 priority:

1. embedded cover
2. same-folder `cover`, `folder`, or `front` image
3. generated default cover

Network covers are intentionally excluded so local artwork cannot be overwritten by an incorrect match.

Cover layers:

- `thumb_path`: SongsPage and AlbumsPage
- `large_path`: reserved for NowPlaying/detail
- `original_ref`: retained for on-demand original access

## Album Grouping

`album_key` is based on normalized:

- `albumArtist || artist`
- `album`
- `year`

Rules:

- same album + same albumArtist merges
- same album + different albumArtist does not merge
- missing/unknown albumArtist uses folder path as a weak separator
- empty/unknown album values get per-track keys and do not create one giant Unknown Album
- albums and album_tracks are persisted

## API And UI Data Flow

Preload exposes typed methods only:

- `library.addFolder(path)`
- `library.getFolders()`
- `library.removeFolder(folderId)`
- `library.scanFolder(folderId)`
- `library.getScanStatus(jobId)`
- `library.cancelScan(jobId)`
- `library.getTracks({ page, pageSize, search, sort })`
- `library.getAlbums({ page, pageSize, search, sort })`
- `library.getAlbumTracks(albumId, { page, pageSize })`
- `library.getSummary()`

IPC handlers validate input and call `LibraryService`. SQL, scanning, metadata, cover, and grouping logic stay inside Library Core.

`SongsPage` reads paged tracks with `pageSize = 100`, keeps search debounced, and renders a virtualized `TrackList`. Track rows receive `coverThumb` only.

`AlbumsPage` reads paged albums with `pageSize = 60` from the persisted `albums` table. It never regroups tracks in Renderer.

Settings has a minimal Library Folders panel for adding a local folder path, scanning, cancelling scans, rescanning, and removing a folder from the library. It is not a file manager and never copies, moves, renames, or deletes disk files.

## Performance Budget

- startup does not scan the full library
- `getTracks` first page target: under 200 ms
- `getAlbums` first page target: under 300 ms
- unchanged scan skip rate should approach 100%
- cover thumbs are generated during scan, not UI scroll
- album wall reads `albums` after restart
- list APIs do not return full covers
- scans are backgrounded and cancellable
- metadata and cover workers have concurrency limits
- large libraries must not hold CPU near 50% because the album wall is rendering
