import { Module } from '@nestjs/common';
import { FilesController } from '../files/files.controller';
import { FilesService } from '../files/files.service';
import { CatalogService } from './catalog.service';
import { InspectionsService } from './inspections.service';
import { InventoryService } from './inventory.service';
import { VehicleMediaService } from './media.service';
import { CatalogController, InspectionsController, InventoryController, VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

@Module({
  controllers: [VehiclesController, InspectionsController, InventoryController, CatalogController, FilesController],
  providers: [VehiclesService, VehicleMediaService, InspectionsService, InventoryService, CatalogService, FilesService],
  exports: [VehiclesService, InspectionsService, FilesService, InventoryService],
})
export class VehiclesModule {}
