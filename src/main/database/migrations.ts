import type { EchoDatabase } from './createDatabase';
import { librarySchemaSql, schemaMigrationTableSql } from './schema';

type Migration = {
  id: number;
  apply: (database: EchoDatabase) => void;
};

type ColumnInfoRow = {
  name: string;
};

const hasColumn = (database: EchoDatabase, tableName: string, columnName: string): boolean => {
  const rows = database.prepare<unknown[], ColumnInfoRow>(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
};

const addColumnIfMissing = (
  database: EchoDatabase,
  tableName: string,
  columnName: string,
  columnSql: string,
): void => {
  if (!hasColumn(database, tableName, columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`);
  }
};

export const migrations: Migration[] = [
  {
    id: 1,
    apply: (database) => database.exec(librarySchemaSql),
  },
  {
    id: 2,
    apply: (database) => {
      addColumnIfMissing(database, 'tracks', 'track_no', 'track_no INTEGER');
      addColumnIfMissing(database, 'tracks', 'disc_no', 'disc_no INTEGER');
      addColumnIfMissing(database, 'tracks', 'year', 'year INTEGER');
      addColumnIfMissing(database, 'scan_jobs', 'phase', "phase TEXT NOT NULL DEFAULT 'queued'");
      addColumnIfMissing(database, 'scan_jobs', 'removed_tracks', 'removed_tracks INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: 3,
    apply: (database) => {
      addColumnIfMissing(database, 'folders', 'enabled', 'enabled INTEGER NOT NULL DEFAULT 1');
      addColumnIfMissing(database, 'folders', 'last_scan_at', 'last_scan_at TEXT');

      addColumnIfMissing(database, 'tracks', 'genre', 'genre TEXT');
      addColumnIfMissing(database, 'tracks', 'metadata_status', "metadata_status TEXT NOT NULL DEFAULT 'ok'");
      addColumnIfMissing(database, 'tracks', 'missing', 'missing INTEGER NOT NULL DEFAULT 0');

      addColumnIfMissing(database, 'albums', 'year', 'year INTEGER');

      addColumnIfMissing(database, 'album_tracks', 'disc_no', 'disc_no INTEGER');
      addColumnIfMissing(database, 'album_tracks', 'track_no', 'track_no INTEGER');

      addColumnIfMissing(database, 'artists', 'sort_name', 'sort_name TEXT');
      addColumnIfMissing(database, 'artists', 'track_count', 'track_count INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(database, 'artists', 'album_count', 'album_count INTEGER NOT NULL DEFAULT 0');

      addColumnIfMissing(database, 'covers', 'thumb_path', 'thumb_path TEXT');
      addColumnIfMissing(database, 'covers', 'large_path', 'large_path TEXT');
      addColumnIfMissing(database, 'covers', 'original_ref', 'original_ref TEXT');

      addColumnIfMissing(database, 'scan_jobs', 'discovered_count', 'discovered_count INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(database, 'scan_jobs', 'parsed_count', 'parsed_count INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(database, 'scan_jobs', 'skipped_count', 'skipped_count INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(database, 'scan_jobs', 'cover_count', 'cover_count INTEGER NOT NULL DEFAULT 0');

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_album_tracks_track_id ON album_tracks(track_id);
        CREATE INDEX IF NOT EXISTS idx_covers_id ON covers(id);
      `);
    },
  },
];

export const runMigrations = (database: EchoDatabase): void => {
  database.exec(schemaMigrationTableSql);

  const appliedRows = database.prepare<unknown[], { id: number }>('SELECT id FROM schema_migrations').all();
  const appliedIds = new Set(appliedRows.map((row) => Number(row.id)));

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    database.exec('BEGIN');

    try {
      migration.apply(database);
      database
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
};
