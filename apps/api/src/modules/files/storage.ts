import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Env } from '../../config/env';

/** Object storage abstraction: local disk for development/tests, S3-compatible in production. */
export interface StorageDriver {
  readonly name: string;
  put(key: string, sourcePath: string, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

function safeKey(key: string): string {
  if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes('..') || key.startsWith('/')) {
    throw new Error('Invalid storage key');
  }
  return key;
}

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  private full(key: string): string {
    const p = path.resolve(this.root, safeKey(key));
    if (!p.startsWith(this.root + path.sep)) throw new Error('Path traversal blocked');
    return p;
  }
  async put(key: string, sourcePath: string): Promise<void> {
    const dest = this.full(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(sourcePath, dest);
  }
  async get(key: string): Promise<Readable> {
    const p = this.full(key);
    await stat(p);
    return createReadStream(p);
  }
  async delete(key: string): Promise<void> {
    await rm(this.full(key), { force: true });
  }
}

/** S3-compatible driver (AWS S3, Cloudflare R2, MinIO). Not exercised in this environment — needs a bucket. */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3';
  private readonly client: S3Client;
  constructor(private readonly bucket: string, env: Env) {
    this.client = new S3Client({
      region: env.S3_REGION ?? 'auto',
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: !!env.S3_ENDPOINT,
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  async put(key: string, sourcePath: string, contentType: string): Promise<void> {
    const { size } = await stat(sourcePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: safeKey(key),
        Body: createReadStream(sourcePath),
        ContentLength: size,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
  }
  async get(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
    return res.Body as Readable;
  }
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
  }
}

export function createStorage(env: Env): StorageDriver {
  return env.STORAGE_DRIVER === 's3' ? new S3StorageDriver(env.S3_BUCKET!, env) : new LocalStorageDriver(env.STORAGE_LOCAL_DIR);
}
