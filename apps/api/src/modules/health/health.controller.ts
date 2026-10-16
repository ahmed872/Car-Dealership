import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { NoTransaction, Public } from '../../common/context';
import { AppError } from '../../common/errors';
import { DbService } from '../../db/db.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly dbs: DbService) {}

  @Get('live')
  @Public()
  @NoTransaction()
  live() {
    return { status: 'ok' };
  }

  /** Ready when the database answers and migrations are applied. */
  @Get('ready')
  @Public()
  @NoTransaction()
  async ready() {
    try {
      const { rows } = await this.dbs.pool.query<{ ok: number; fn: string | null }>(
        "SELECT 1 AS ok, to_regprocedure('app_current_tenant()')::text AS fn",
      );
      if (!rows[0]?.fn) throw new Error('schema not migrated');
      return { status: 'ok', database: 'up' };
    } catch {
      throw new AppError('not_ready', 503, 'Database unavailable');
    }
  }
}
