import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1.
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  /** Precomputed hash used to keep timing similar when the account does not exist. */
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= hash('dummy-password-for-timing', OPTIONS);
    await this.verify(await this.dummyHash, password);
  }
}
