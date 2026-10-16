import type { RouteObject } from 'react-router-dom';
import { InspectionPage } from '@/features/vehicles/InspectionPage';
import { StockCountDetailPage, StockCountsPage, TransfersPage } from '@/features/vehicles/InventoryPages';
import { VehicleDetailPage } from '@/features/vehicles/VehicleDetailPage';
import { VehicleFormPage } from '@/features/vehicles/VehicleFormPage';
import { VehiclesListPage } from '@/features/vehicles/VehiclesListPage';
import { Guard } from './Guard';

/** Domain module routes, registered as each phase is delivered. */
export const featureRoutes: { app: RouteObject[]; public: RouteObject[] } = {
  app: [
    { path: 'vehicles', element: <Guard anyOf={['vehicles.read']}><VehiclesListPage /></Guard> },
    { path: 'vehicles/new', element: <Guard anyOf={['vehicles.create']}><VehicleFormPage /></Guard> },
    { path: 'vehicles/:id', element: <Guard anyOf={['vehicles.read']}><VehicleDetailPage /></Guard> },
    { path: 'vehicles/:id/edit', element: <Guard anyOf={['vehicles.update']}><VehicleFormPage /></Guard> },
    { path: 'inspections/:id', element: <Guard anyOf={['inspections.read']}><InspectionPage /></Guard> },
    { path: 'inventory/transfers', element: <Guard anyOf={['vehicles.read']}><TransfersPage /></Guard> },
    { path: 'inventory/stock-counts', element: <Guard anyOf={['inventory.count']}><StockCountsPage /></Guard> },
    { path: 'inventory/stock-counts/:id', element: <Guard anyOf={['inventory.count']}><StockCountDetailPage /></Guard> },
  ],
  public: [],
};
