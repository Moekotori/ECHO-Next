import type { DatabaseSync } from 'node:sqlite';
import { librarySchemaSql, schemaMigrationTableSql } from './schema';

type Migration = {
  id: number;
  apply: (database: DatabaseSync) => void;
};

const hasColumn = (database: DatabaseSync, tableName: string, columnName: string): boolean => {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
};

const addColumnIfMissing = (
  database: DatabaseSync,
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
];

export const runMigrations = (database: DatabaseSync): void => {
  database.exec(schemaMigrationTableSql);

  const appliedRows = database.prepare('SELECT id FROM schema_migrations').all();
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
