import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Permission } from '@autohub/shared';
import { getEnv } from '../../config/env';
import { AuthContext } from '../../common/context';
import { AppError, forbidden, notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { files } from '../../db/schema';
import { createStorage, StorageDriver } from './storage';
import { scrubJpeg, scrubPng, sniff, SniffedType } from './sniff';

export interface UploadedTemp {
  path: string;
  originalname: string;
  size: number;
}

export type FilePurpose =
  | 'vehicle_media'
  | 'vehicle_document'
  | 'inspection_media'
  | 'attachment'
  | 'company_logo'
  | 'generated_document';

const ALLOWED: Record<FilePurpose, Array<SniffedType['kind']>> = {
  vehicle_media: ['image', 'video'],
  vehicle_document: ['image', 'pdf'],
  inspection_media: ['image', 'video'],
  attachment: ['image', 'pdf'],
  company_logo: ['image'],
  generated_document: ['pdf'],
};

/**
 * Stores files under tenant-prefixed keys after verifying the real content type. Each file
 * records the permission required to read it; downloads are always authorised server-side.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  readonly storage: StorageDriver;

  constructor(private readonly dbs: DbService) {
    this.storage = createStorage(getEnv());
  }

  /** Must run inside a tenant transaction; the stored object is removed if the transaction rolls back. */
  async store(
    upload: UploadedTemp,
    opts: { purpose: FilePurpose; readPermission: Permission | 'authenticated'; scrub?: boolean },
  ): Promise<{ id: string; mimeType: string; kind: SniffedType['kind'] }> {
    const ctx = this.dbs.context;
    if (!ctx?.tenantId) throw new Error('File storage requires tenant context');
    const head = Buffer.alloc(16);
    const fh = await open(upload.path, 'r');
    try {
      await fh.read(head, 0, 16, 0);
    } finally {
      await fh.close();
    }
    const type = sniff(head);
    if (!type || !ALLOWED[opts.purpose].includes(type.kind)) {
      throw new AppError('unsupported_file_type', 415, 'This file type is not allowed here', {
        allowed: ALLOWED[opts.purpose],
      });
    }
    if (type.kind === 'image' && opts.scrub !== false) {
      const buf = await readFile(upload.path);
      const cleaned = type.mime === 'image/jpeg' ? scrubJpeg(buf) : type.mime === 'image/png' ? scrubPng(buf) : buf;
      if (cleaned !== buf) await writeFile(upload.path, cleaned);
    }
    const sha256 = await new Promise<string>((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(upload.path)
        .on('data', (c) => h.update(c))
        .on('end', () => resolve(h.digest('hex')))
        .on('error', reject);
    });
    const now = new Date();
    const key = `tenants/${ctx.tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    await this.storage.put(key, upload.path, type.mime);
    this.dbs.onRollback(() => this.storage.delete(key));
    const [row] = await this.dbs.db
      .insert(files)
      .values({
        tenantId: ctx.tenantId,
        storageKey: key,
        originalName: sanitizeName(upload.originalname),
        mimeType: type.mime,
        sizeBytes: (await stat(upload.path)).size,
        sha256,
        purpose: `${opts.purpose}:${opts.readPermission}`,
        uploadedBy: ctx.userId,
      })
      .returning({ id: files.id });
    return { id: row!.id, mimeType: type.mime, kind: type.kind };
  }

  /** Removes the object after the surrounding transaction commits (DB row deletion happens in-tx). */
  scheduleDelete(storageKey: string): void {
    this.dbs.afterCommit(() => this.storage.delete(storageKey));
  }

  async cleanupTemp(paths: Array<string | undefined>): Promise<void> {
    await Promise.all(paths.filter(Boolean).map((p) => rm(p!, { force: true }).catch(() => undefined)));
  }

  /** Loads file metadata and enforces its read permission for the caller. */
  async authorize(auth: AuthContext, fileId: string) {
    const [f] = await this.dbs.db.select().from(files).where(eq(files.id, fileId)).limit(1);
    if (!f) throw notFound('File');
    const perm = f.purpose.split(':')[1];
    if (perm && perm !== 'authenticated' && !auth.permissions.has(perm as Permission)) {
      throw forbidden('You do not have access to this file');
    }
    return f;
  }

  async open(storageKey: string) {
    try {
      return await this.storage.get(storageKey);
    } catch (e) {
      this.logger.error(`Missing stored object ${storageKey}: ${(e as Error).message}`);
      throw notFound('File content');
    }
  }
}

export function sanitizeName(name: string): string {
  const base = (name || 'file').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  return base.slice(-120);
}

export function tempUploadDir(): string {
  return `${tmpdir()}/autohub-uploads`;
}
