import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  patchOf,
  zDocumentInput,
  zFeatureInput,
  zInspectionSave,
  zInspectionStart,
  zMakeInput,
  zMediaOrder,
  zMediaUpdate,
  zModelInput,
  zOdometerReading,
  zReason,
  zStockCountCreate,
  zStockCountReconcile,
  zStockCountScan,
  zTemplateInput,
  zTransferCreate,
  zVehicleCreate,
  zVehicleFeatures,
  zVehicleListQuery,
  zVehiclePricing,
  zVehicleStatusChange,
  zVehicleUpdate,
} from '@autohub/shared';
import { Authenticated, Ctx, NoTransaction, RequirePermissions, TenantContext } from '../../common/context';
import { badRequest } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { FilesService } from '../files/files.service';
import { UploadFile } from '../files/upload';
import { CatalogService } from './catalog.service';
import { InspectionsService } from './inspections.service';
import { InventoryService } from './inventory.service';
import { VehicleMediaService } from './media.service';
import { VehiclesService } from './vehicles.service';

class VehicleCreateDto extends createZodDto(zVehicleCreate) {}
class VehicleUpdateDto extends createZodDto(zVehicleUpdate) {}
class VehicleListQueryDto extends createZodDto(zVehicleListQuery) {}
class StatusChangeDto extends createZodDto(zVehicleStatusChange) {}
class PricingDto extends createZodDto(zVehiclePricing) {}
class OdometerDto extends createZodDto(zOdometerReading) {}
class FeaturesDto extends createZodDto(zVehicleFeatures) {}
class MediaUpdateDto extends createZodDto(zMediaUpdate) {}
class MediaOrderDto extends createZodDto(zMediaOrder) {}
class DocumentUpdateDto extends createZodDto(patchOf(zDocumentInput)) {}
class ReasonDto extends createZodDto(zReason) {}
class MakeDto extends createZodDto(zMakeInput) {}
class ModelDto extends createZodDto(zModelInput) {}
class FeatureDto extends createZodDto(zFeatureInput) {}
class TemplateDto extends createZodDto(zTemplateInput) {}
class InspectionStartDto extends createZodDto(zInspectionStart) {}
class InspectionSaveDto extends createZodDto(zInspectionSave) {}
class TransferDto extends createZodDto(zTransferCreate) {}
class StockCountDto extends createZodDto(zStockCountCreate) {}
class ScanDto extends createZodDto(zStockCountScan) {}
class ReconcileDto extends createZodDto(zStockCountReconcile) {}

type Upload = Express.Multer.File | undefined;

const zMediaMeta = z.object({
  category: z.string().max(20).optional(),
  caption: z.string().max(200).optional(),
  isPublic: z.enum(['true', 'false']).optional(),
});

@ApiTags('vehicles')
@Controller('vehicles')
export class VehiclesController {
  constructor(
    private readonly vehicles: VehiclesService,
    private readonly media: VehicleMediaService,
    private readonly inspections: InspectionsService,
    private readonly inventory: InventoryService,
    private readonly files: FilesService,
    private readonly dbs: DbService,
  ) {}

  private tx<T>(ctx: TenantContext, fn: () => Promise<T>) {
    return this.dbs.runInTenant({ tenantId: ctx.tenant.id, userId: ctx.userId }, fn);
  }

  @Get()
  @RequirePermissions('vehicles.read')
  list(@Ctx() ctx: TenantContext, @Query() q: VehicleListQueryDto) {
    return this.vehicles.list(ctx, q);
  }

  @Post()
  @RequirePermissions('vehicles.create')
  create(@Ctx() ctx: TenantContext, @Body() body: VehicleCreateDto) {
    return this.vehicles.create(ctx, body);
  }

  @Get(':id')
  @RequirePermissions('vehicles.read')
  detail(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.vehicles.detail(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('vehicles.update')
  update(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: VehicleUpdateDto) {
    return this.vehicles.update(ctx, id, body);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermissions('vehicles.change_status')
  changeStatus(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: StatusChangeDto) {
    return this.vehicles.transition(ctx, id, body.to, { system: false, source: 'manual', reason: body.reason ?? null });
  }

  @Put(':id/pricing')
  @RequirePermissions('pricing.update')
  pricing(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PricingDto) {
    return this.vehicles.setPricing(ctx, id, body);
  }

  @Post(':id/odometer')
  @RequirePermissions('vehicles.update')
  odometer(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: OdometerDto) {
    return this.vehicles.addOdometer(ctx, id, body);
  }

  @Put(':id/features')
  @RequirePermissions('vehicles.update')
  setFeatures(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: FeaturesDto) {
    return this.vehicles.updateFeatures(ctx, id, body.featureIds);
  }

  // ── Media ────────────────────────────────────────────────────────────────────────────
  @Post(':id/media')
  @NoTransaction()
  @RequirePermissions('vehicles.manage_media')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(UploadFile('file', 200))
  async uploadMedia(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Upload, @Body() body: unknown) {
    if (!file) throw badRequest('file_required', 'Attach a file');
    try {
      const meta = zMediaMeta.parse(body ?? {});
      return await this.tx(ctx, () =>
        this.media.addMedia(ctx, id, file, { category: meta.category, caption: meta.caption ?? null, isPublic: meta.isPublic ? meta.isPublic === 'true' : undefined }),
      );
    } finally {
      await this.files.cleanupTemp([file.path]);
    }
  }

  @Patch(':id/media/:mediaId')
  @RequirePermissions('vehicles.manage_media')
  updateMedia(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('mediaId', ParseUUIDPipe) mediaId: string, @Body() body: MediaUpdateDto) {
    return this.media.updateMedia(ctx, id, mediaId, body);
  }

  @Put(':id/media/order')
  @RequirePermissions('vehicles.manage_media')
  reorderMedia(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: MediaOrderDto) {
    return this.media.reorder(ctx, id, body.mediaIds);
  }

  @Delete(':id/media/:mediaId')
  @RequirePermissions('vehicles.manage_media')
  deleteMedia(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('mediaId', ParseUUIDPipe) mediaId: string) {
    return this.media.deleteMedia(ctx, id, mediaId);
  }

  // ── Documents ────────────────────────────────────────────────────────────────────────
  @Post(':id/documents')
  @NoTransaction()
  @RequirePermissions('vehicles.manage_documents')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(UploadFile('file'))
  async addDocument(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Upload, @Body() body: unknown) {
    try {
      const input = zDocumentInput.parse(body ?? {});
      return await this.tx(ctx, () => this.media.addDocument(ctx, id, input, file));
    } finally {
      await this.files.cleanupTemp([file?.path]);
    }
  }

  @Patch(':id/documents/:docId')
  @RequirePermissions('vehicles.manage_documents')
  updateDocument(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @Body() body: DocumentUpdateDto) {
    return this.media.updateDocument(ctx, id, docId, body);
  }

  @Post(':id/documents/:docId/delete')
  @HttpCode(200)
  @RequirePermissions('vehicles.manage_documents')
  deleteDocument(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @Body() body: ReasonDto) {
    return this.media.deleteDocument(ctx, id, docId, body.reason);
  }

  // ── Inspections ──────────────────────────────────────────────────────────────────────
  @Post(':id/inspections')
  @RequirePermissions('inspections.perform')
  startInspection(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: InspectionStartDto) {
    return this.inspections.start(ctx, id, body);
  }

  // ── Transfers ────────────────────────────────────────────────────────────────────────
  @Post(':id/transfers')
  @RequirePermissions('inventory.transfer')
  transfer(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: TransferDto) {
    return this.inventory.createTransfer(ctx, id, body.toBranchId, body.notes ?? null);
  }
}

@ApiTags('inspections')
@Controller('inspections')
export class InspectionsController {
  constructor(
    private readonly inspections: InspectionsService,
    private readonly files: FilesService,
    private readonly dbs: DbService,
  ) {}

  @Get('templates')
  @RequirePermissions('inspections.read')
  templates() {
    return this.inspections.listTemplates();
  }

  @Post('templates')
  @RequirePermissions('inspections.manage_templates')
  createTemplate(@Ctx() ctx: TenantContext, @Body() body: TemplateDto) {
    return this.inspections.createTemplate(ctx, body);
  }

  @Put('templates/:id')
  @RequirePermissions('inspections.manage_templates')
  updateTemplate(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: TemplateDto) {
    return this.inspections.updateTemplate(ctx, id, body);
  }

  @Get(':id')
  @RequirePermissions('inspections.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.inspections.get(ctx, id);
  }

  @Put(':id')
  @RequirePermissions('inspections.perform')
  save(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: InspectionSaveDto) {
    return this.inspections.save(ctx, id, body);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermissions('inspections.perform')
  complete(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.inspections.complete(ctx, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('inspections.perform')
  cancel(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.inspections.cancel(ctx, id, body.reason);
  }

  @Post(':id/media')
  @NoTransaction()
  @RequirePermissions('inspections.perform')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(UploadFile('file', 100))
  async media(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Upload, @Body() body: Record<string, string>) {
    if (!file) throw badRequest('file_required', 'Attach a file');
    try {
      return await this.dbs.runInTenant({ tenantId: ctx.tenant.id, userId: ctx.userId }, () =>
        this.inspections.addMedia(ctx, id, file, {
          itemKey: body?.itemKey?.slice(0, 40) || null,
          panelCode: body?.panelCode?.slice(0, 40) || null,
          caption: body?.caption?.slice(0, 200) || null,
        }),
      );
    } finally {
      await this.files.cleanupTemp([file.path]);
    }
  }
}

@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('transfers')
  @RequirePermissions('vehicles.read')
  transfers(@Ctx() ctx: TenantContext, @Query('status') status?: string) {
    return this.inventory.listTransfers(ctx, status && /^(in_transit|received|cancelled)$/.test(status) ? status : undefined);
  }

  @Post('transfers/:id/receive')
  @HttpCode(200)
  @RequirePermissions('inventory.transfer')
  receive(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.receiveTransfer(ctx, id);
  }

  @Post('transfers/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('inventory.transfer')
  cancelTransfer(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.inventory.cancelTransfer(ctx, id, body.reason);
  }

  @Get('stock-counts')
  @RequirePermissions('inventory.count')
  counts(@Ctx() ctx: TenantContext) {
    return this.inventory.listCounts(ctx);
  }

  @Post('stock-counts')
  @RequirePermissions('inventory.count')
  openCount(@Ctx() ctx: TenantContext, @Body() body: StockCountDto) {
    return this.inventory.openCount(ctx, body.branchId, body.notes ?? null);
  }

  @Get('stock-counts/:id')
  @RequirePermissions('inventory.count')
  getCount(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.getCount(ctx, id);
  }

  @Post('stock-counts/:id/scan')
  @HttpCode(200)
  @RequirePermissions('inventory.count')
  scan(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ScanDto) {
    return this.inventory.scan(ctx, id, body.code, body.location ?? null, body.notes ?? null);
  }

  @Post('stock-counts/:id/submit')
  @HttpCode(200)
  @RequirePermissions('inventory.count')
  submit(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.submitCount(ctx, id);
  }

  @Post('stock-counts/:id/reconcile')
  @HttpCode(200)
  @RequirePermissions('inventory.reconcile')
  reconcile(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReconcileDto) {
    return this.inventory.reconcile(ctx, id, body.lines);
  }
}

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('makes')
  @Authenticated()
  makes() {
    return this.catalog.makes();
  }

  @Post('makes')
  @RequirePermissions('vehicles.create')
  addMake(@Ctx() ctx: TenantContext, @Body() body: MakeDto) {
    return this.catalog.addMake(ctx, body);
  }

  @Get('models')
  @Authenticated()
  models(@Query('makeId') makeId?: string) {
    return this.catalog.models(makeId && /^[0-9a-f-]{36}$/i.test(makeId) ? makeId : undefined);
  }

  @Post('models')
  @RequirePermissions('vehicles.create')
  addModel(@Ctx() ctx: TenantContext, @Body() body: ModelDto) {
    return this.catalog.addModel(ctx, body);
  }

  @Get('features')
  @Authenticated()
  features() {
    return this.catalog.features();
  }

  @Post('features')
  @RequirePermissions('vehicles.update')
  addFeature(@Ctx() ctx: TenantContext, @Body() body: FeatureDto) {
    return this.catalog.addFeature(ctx, body);
  }
}
