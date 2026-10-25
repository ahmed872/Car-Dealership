import { Controller, Get, Param, ParseUUIDPipe, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { contentDisposition } from '../../common/content-disposition';
import { Authenticated, Ctx, TenantContext } from '../../common/context';
import { FilesService } from './files.service';

@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** Authorised download. Private files never get public, permanent URLs. */
  @Get(':id')
  @Authenticated()
  async download(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const f = await this.files.authorize(ctx, id);
    const stream = await this.files.open(f.storageKey);
    const inline = /^(image\/|video\/|application\/pdf)/.test(f.mimeType);
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Length', String(f.sizeBytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // D-051: one header builder for every download (ASCII fallback + exact UTF-8 name).
    res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', f.originalName));
    return new StreamableFile(stream);
  }
}
