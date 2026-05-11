# ECHO Next Library Core

Phase 1 owns local library persistence and scan performance. It fixes the old ECHO pain points by making SQLite the source of truth: restarting the app reads cached folders, tracks, albums, artists, covers, and scan jobs directly from disk instead of reparsing the whole library.

The renderer is a consumer only. It never scans folders, parses metadata, extracts covers, groups albums, or receives full cover payloads.

## Modules

`LibraryService`

- public facade used by IPC
- owns the default Library Core composition
- exposes folder, scan, track, album, album-track, and summary APIs

`LibraryStore`

- owns all SQLite reads and writes
- runs migrations
- performs paged track, album, and album-track queries
- tracks scan jobs, phases, errors, cancellation, and incremental fingerprints
- batches scan writes in explicit transactions

`LibraryScanner`

- recursively walks local folders
- filters supported audio extensions
- returns only `path`, `folderId`, `sizeBytes`, and `mtimeMs`

`MetadataService`

- reads embedded tags with `music-metadata`
- stores `title`, `artist`, `album`, `albumArtist`, `trackNo`, `discNo`, `year`, `duration`, `codec`, `sampleRate`, `bitDepth`, and `bitrate`
- records per-field provenance in `field_sources_json`

`CoverService`

- resolves cover priority
- writes cached `thumb`, `large`, and `original` files to disk
- stores only cache paths in SQLite
- never returns full cover binary or base64 through list APIs

`AlbumService`

- owns `album_key` generation
- groups by normalized album artist, album title, and year
- prevents unknown or empty album values from collapsing into one giant album

`ScanJobQueue`

- starts background scan jobs
- reports phases and progress
- supports cancellation and error collection
- limits concurrent metadata reads to keep CPU spikes down

## SQLite Schema

Core tables:

- `folders`: imported local roots and active/removed state
- `tracks`: canonical metadata, field sources, cover id, and `path + size_bytes + mtime_ms`
- `albums`: persisted album wall records
- `album_tracks`: persisted album-to-track order
- `artists`: persisted artist index
- `covers`: `source_type`, hash, MIME type, and cached `cover_thumb`, `cover_large`, `cover_original` paths
- `scan_jobs`: status, phase, progress counters, cancellation flag, and errors

Important indexes:

- `tracks(path)`
- `tracks(folder_id)`
- `tracks(title)`
- `tracks(artist)`
- `tracks(album)`
- `albums(album_key)`
- `album_tracks(album_id)`
- `folders(path)`

## Scan Pipeline

1. `library.scanFolder(folderId)` creates a `scan_jobs` row and returns immediately.
2. `ScanJobQueue` runs in the background.
3. Phase `discovering_files`: `LibraryScanner` discovers audio files and stats each file.
4. Phase `checking_cache`: existing track rows are compared by `path + size_bytes + mtime_ms`.
5. Unchanged files are counted as skipped. Metadata and cover extraction are not called.
6. Phase `reading_metadata`: changed or new files are parsed with a small concurrency limit.
7. Per-file metadata failures are collected in `errors`; they do not fail the whole scan.
8. Phase `extracting_covers`: cover candidates are resolved for changed or new tracks.
9. Phase `grouping_albums`: albums and album-track rows are rebuilt from persisted track rows.
10. Phase `writing_database`: track, cover, album, artist, and scan-job updates are committed through SQLite transactions.
11. Phase `finished`, `failed`, or `cancelled` is written to `scan_jobs`.

Deletion policy: if a file disappears from a scanned library folder, the track row is removed on the next scan. Cover cache files are retained because they are hash-addressed and may be reused by another track.

## Cache Strategy

The incremental key is:

- `path`
- `size_bytes`
- `mtime_ms`

When all three match, ECHO Next trusts the existing SQLite metadata and cover links. This is why restart and refresh do not re-read every embedded tag or regenerate album wall data.

Albums are persisted in `albums` and `album_tracks`, so the album wall reads cached rows after restart instead of grouping the whole track table in renderer memory.

Covers are deduplicated by content hash. Cached files are written once and reused by later scans.

## Metadata Priority

The fixed priority is:

1. manual user edits
2. embedded tags
3. sidecar/info files
4. folder structure
5. network completion
6. filename fallback

Phase 1 implements embedded tags, folder album fallback, and filename fallback. Filename guessing only fills missing fields. It must not overwrite embedded `title`, `artist`, or `album`, which prevents the old "Unknown Artist forever" failure when valid tags exist.

Every stored field writes a source entry in `field_sources_json`.

## Cover Priority

Phase 1 cover priority is:

1. embedded cover
2. same-folder `cover`, `folder`, or `front` image
3. generated default cover

Network covers are intentionally excluded from Phase 1 so they cannot overwrite local or embedded artwork.

List APIs return `coverThumb` only. They do not return `cover_large`, `cover_original`, raw binary cover data, or base64 payloads.

## Album Grouping

`album_key` is based on:

- normalized `albumArtist || artist`
- normalized `album`
- `year`

If album artist is missing or unknown, folder path is used as a weak separator. If album is empty or unknown, each track receives a unique album key so unrelated loose files do not merge into one giant "Unknown Album".

Rules:

- same album + same album artist merges
- same album + different album artist does not merge
- same album + same artist + different year does not merge
- empty album values stay separated

## API And Data Flow

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

IPC handlers validate input and call `LibraryService`. SQL, scanning, metadata parsing, cover handling, and album grouping stay inside Library Core.

`SongsPage` reads paged tracks with `pageSize = 100` and keeps search debounced. `TrackList` is virtualized and list rows receive only `coverThumb`.

`AlbumsPage` reads paged albums from the persisted `albums` table with `pageSize = 60`. Entering the page never recomputes album grouping.

## Test Coverage

Phase 1 tests cover:

- repeatable migrations
- persistent folders
- incremental skip by path, size, and mtime
- reparse when mtime or size changes
- deleted file removal policy
- embedded metadata priority
- embedded cover priority
- list API cover safety
- album merge and split rules
- empty album separation
- persisted album reads after restart
- paged track and album-track APIs
- scan-job phases and error reporting
