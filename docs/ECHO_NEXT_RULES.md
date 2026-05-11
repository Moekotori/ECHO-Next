# ECHO Next Rules

These rules are architectural guardrails. They are part of Phase 0 and should be treated as development constraints.

## File Size And Ownership

1. No giant `App.tsx`.
2. No giant `main/index.ts`.
3. No giant global CSS file.
4. Pages over 500 lines must be split.
5. Services over 800 lines must be split.
6. Shared abstractions must have a clear owner and purpose.

## App Entrypoints

`src/renderer/app/App.tsx` may only compose:

- providers
- layout
- routes
- future error boundary

`src/main/index.ts` may only compose:

- app lifecycle
- main window creation through lifecycle
- IPC registration
- necessary service bootstrap

## Renderer Rules

The renderer must not:

- scan folders
- read metadata
- parse covers
- load full covers for lists
- decide album grouping
- hold the whole library in React state
- run heavy search over a full in-memory track array
- let high-frequency playback state rerender the entire app

Songs, albums, artists, and search results must be paged or virtualized.

Current Phase 1 list defaults:

- songs: `pageSize = 100`
- albums: `pageSize = 60`
- track rows are virtualized with an estimated 70px row height

## Preload Rules

Preload must:

- expose `window.echo`
- keep APIs grouped by domain
- return typed results

Preload must not:

- expose raw `ipcRenderer`
- access files directly
- implement business logic
- parse metadata or covers

## Metadata Priority

Metadata priority is fixed:

1. user manual edit
2. embedded tags
3. sidecar/info files
4. folder structure
5. network completion
6. filename fallback

Filename guessing must never overwrite embedded `title`, `artist`, or `album`.

Network metadata must never overwrite embedded tags.

Every stored track must preserve per-field source information in `field_sources_json`.

Phase 1 must persist at least:

- `title`
- `artist`
- `album`
- `albumArtist`
- `trackNo`
- `discNo`
- `year`
- `duration`
- `codec`
- `sampleRate`
- `bitDepth`
- `bitrate`

## Cover Priority

Long-term cover priority is fixed:

1. user manual cover
2. embedded cover
3. local folder cover
4. sidecar cover
5. network cover
6. generated placeholder

Network covers must never overwrite manual, embedded, or local covers.

Phase 1 implements embedded cover, same-folder `cover/folder/front` images, and generated default cover only. Network cover lookup is forbidden in Phase 1.

Covers must be stored as:

- thumb
- large
- original

List views use thumb only. Full covers load on demand.

List APIs must never return `cover_large`, `cover_original`, raw binary cover data, or base64 cover payloads.

## Long Tasks

All long tasks must be:

- backgrounded
- cancellable
- progress-reporting
- error-collecting

This includes scanning, metadata extraction, cover generation, audio analysis, and future network enrichment.

Local library scans must skip metadata parsing when `path + size_bytes + mtime_ms` is unchanged.

Scan jobs must report one of these phases:

- `discovering_files`
- `checking_cache`
- `reading_metadata`
- `extracting_covers`
- `grouping_albums`
- `writing_database`
- `finished`
- `failed`
- `cancelled`

Per-file metadata or cover errors must be collected without failing the entire scan.

## Library Persistence

SQLite is the source of truth after a scan. Restarting the app must not reparse the whole library.

Required persisted tables:

- `folders`
- `tracks`
- `albums`
- `album_tracks`
- `artists`
- `covers`
- `scan_jobs`

Album wall views must read the `albums` table. They must not regroup the full track table in the renderer.

If a file is removed from a scanned folder, the next scan removes its track row. Disk files must never be deleted by Library Core.

## Album Grouping

Album grouping must be performed in Library Core and persisted.

Rules:

- same album + same album artist merges
- same album + different album artist does not merge
- album artist missing or unknown uses folder path as a weak separator
- empty or unknown album values must not collapse into one giant album
- year participates in the album key when available

## Testing Rules

Changes touching metadata, cover, audio, library, encoding, database migration, or file scanning behavior must include focused tests.

Library Core tests should prefer real SQLite and mocked metadata readers over large binary audio fixtures unless a parser integration bug specifically requires real media.
