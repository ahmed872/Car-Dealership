import type { RouteObject } from 'react-router-dom';

/** Domain module routes are registered here as each phase is delivered. */
export const featureRoutes: { app: RouteObject[]; public: RouteObject[] } = { app: [], public: [] };
