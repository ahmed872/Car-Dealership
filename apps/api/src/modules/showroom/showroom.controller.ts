import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { zListingUpdate, zPaginationQuery, zQrQuery, zShowroomInquiry, zShowroomVehicleQuery } from '@autohub/shared';
import { Ctx, NoTransaction, Public, RequirePermissions, TenantContext } from '../../common/context';
import { contentDisposition } from '../../common/content-disposition';
import { InsightsService } from './insights.service';
import { ListingsService } from './listings.service';
import { PublicShowroomService } from './public-showroom.service';

class ListingUpdateDto extends createZodDto(zListingUpdate) {}
class QrQueryDto extends createZodDto(zQrQuery) {}
class ListingListQueryDto extends createZodDto(zPaginationQuery.extend({ published: z.enum(['true', 'false']).optional() })) {}
class ShowroomVehicleQueryDto extends createZodDto(zShowroomVehicleQuery) {}
class InquiryListQueryDto extends createZodDto(zPaginationQuery.extend({ unlinked: z.enum(['true', 'false']).optional() })) {}
class ShowroomInquiryDto extends createZodDto(zShowroomInquiry) {}

@ApiTags('showroom')
@Controller()
export class ShowroomController {
  constructor(
    private readonly listings: ListingsService,
    private readonly insights: InsightsService,
  ) {}

  @Get('showroom/listings')
  @RequirePermissions('showroom.manage')
  list(@Ctx() ctx: TenantContext, @Query() q: ListingListQueryDto) {
    return this.listings.list(ctx, q);
  }

  /** Online inquiries, newest first; `unlinked=true` lists those waiting for staff triage. */
  @Get('showroom/inquiries')
  @RequirePermissions('leads.assign')
  inquiries(@Ctx() ctx: TenantContext, @Query() q: InquiryListQueryDto) {
    return this.listings.inquiries(ctx, q);
  }

  @Get('vehicles/:id/listing')
  @RequirePermissions('vehicles.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.listings.get(ctx, id);
  }

  @Put('vehicles/:id/listing')
  @RequirePermissions('showroom.manage')
  update(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ListingUpdateDto) {
    return this.listings.update(ctx, id, body);
  }

  @Post('vehicles/:id/listing/publish')
  @HttpCode(200)
  @RequirePermissions('showroom.manage')
  publish(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.listings.publish(ctx, id);
  }

  @Post('vehicles/:id/listing/unpublish')
  @HttpCode(200)
  @RequirePermissions('showroom.manage')
  unpublish(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.listings.unpublish(ctx, id);
  }

  @Post('vehicles/:id/listing/generate-description')
  @HttpCode(200)
  @NoTransaction()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermissions('showroom.manage')
  generate(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.listings.generateDescription(ctx, id);
  }

  @Get('vehicles/:id/listing/qr')
  @RequirePermissions('vehicles.read')
  async qr(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: QrQueryDto, @Res({ passthrough: true }) res: Response) {
    const { contentType, body, filename } = await this.listings.qr(ctx, id, q.format);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', contentDisposition('attachment', filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return new StreamableFile(body);
  }

  @Get('vehicles/:id/price-guidance')
  @RequirePermissions('vehicles.read', 'pricing.update')
  priceGuidance(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.insights.priceGuidance(ctx, id);
  }

  @Get('inventory/aging-recommendations')
  @RequirePermissions('vehicles.read', 'pricing.update')
  aging(@Ctx() ctx: TenantContext) {
    return this.insights.agingRecommendations(ctx);
  }
}

/** Public showroom API: no session, company resolved from the slug, explicit public fields only. */
@ApiTags('public showroom')
@Controller('public/showroom/:slug')
@Public()
@NoTransaction()
export class PublicShowroomController {
  constructor(private readonly showroom: PublicShowroomService) {}

  @Get()
  company(@Param('slug') slug: string) {
    return this.showroom.company(slug);
  }

  @Get('vehicles')
  list(@Param('slug') slug: string, @Query() q: ShowroomVehicleQueryDto) {
    return this.showroom.list(slug, q);
  }

  @Get('vehicles/:listingId')
  detail(@Param('slug') slug: string, @Param('listingId', ParseUUIDPipe) listingId: string) {
    return this.showroom.detail(slug, listingId);
  }

  @Get('media/:mediaId')
  async media(@Param('slug') slug: string, @Param('mediaId', ParseUUIDPipe) mediaId: string, @Res({ passthrough: true }) res: Response) {
    const m = await this.showroom.media(slug, mediaId);
    res.setHeader('Content-Type', m.mimeType);
    res.setHeader('Content-Length', String(m.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=300');
    return new StreamableFile(m.stream);
  }

  /** Inquiries and test-drive requests (rate limited per client). */
  @Post('inquiries')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async inquiry(@Param('slug') slug: string, @Body() body: ShowroomInquiryDto, @Req() req: Request) {
    return this.showroom.inquiry(slug, body, req.ip);
  }
}
