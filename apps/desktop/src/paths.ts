import path from 'node:path';
import { app } from 'electron';

/**
 * Where things live.
 *
 * resources/ (read-only, shipped with the app; `stage/` when running unpackaged):
 *   api/        the API (dist + production node_modules)
 *   web/        the built web app
 *   postgres/   PostgreSQL 16 binaries (bin, lib, share)
 *   guide.pdf
 *
 * data/ (per Windows user, %APPDATA%\AutoHub Pro unless AUTOHUB_DATA_DIR is set):
 *   pgdata/        the database cluster
 *   storage/       uploaded files
 *   secrets.json   database passwords and the encryption key (travel with the backups)
 *   settings.json  machine-local settings (port, backup folder, timestamps)
 *   license.key    the activation key
 *   logs/
 */
export const resourcesDir = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..', 'stage');

export const dataDir = process.env.AUTOHUB_DATA_DIR
  ? path.resolve(process.env.AUTOHUB_DATA_DIR)
  : app.getPath('userData');
// Electron's own profile (cookies, local storage, single-instance lock) lives with the data, so a
// different data folder is a fully separate installation.
if (process.env.AUTOHUB_DATA_DIR) app.setPath('userData', path.join(dataDir, 'browser'));

export const paths = {
  api: path.join(resourcesDir, 'api'),
  web: path.join(resourcesDir, 'web'),
  postgres: path.join(resourcesDir, 'postgres'),
  // Inside the app archive (copied at build time), not a loose file next to the program.
  publicKey: path.join(__dirname, 'license-public-key.txt'),
  guide: path.join(resourcesDir, 'guide.pdf'),
  pgdata: path.join(dataDir, 'pgdata'),
  storage: path.join(dataDir, 'storage'),
  secrets: path.join(dataDir, 'secrets.json'),
  settings: path.join(dataDir, 'settings.json'),
  license: path.join(dataDir, 'license.key'),
  logs: path.join(dataDir, 'logs'),
  renderer: path.join(__dirname, 'renderer'),
};

export const defaultBackupDir = (): string =>
  process.env.AUTOHUB_BACKUP_DIR
    ? path.resolve(process.env.AUTOHUB_BACKUP_DIR)
    : path.join(app.getPath('documents'), 'AutoHub Pro Backups');
