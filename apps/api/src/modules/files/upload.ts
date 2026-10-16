import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { getEnv } from '../../config/env';
import { tempUploadDir } from './files.service';

/**
 * Multipart upload to a temp directory (never memory for large files). The handler must call
 * FilesService.store (which sniffs the real type) and clean the temp file afterwards.
 */
export function UploadFile(field = 'file', maxMb?: number) {
  const dir = tempUploadDir();
  mkdirSync(dir, { recursive: true });
  return FileInterceptor(field, {
    storage: diskStorage({ destination: dir, filename: (_req, _file, cb) => cb(null, randomUUID()) }),
    limits: { fileSize: (maxMb ?? getEnv().MAX_UPLOAD_MB) * 1024 * 1024, files: 1, fields: 30, fieldSize: 64 * 1024 },
  });
}
