import { describe, expect, it } from 'vitest';
import { matchesWish, MatchableVehicle, wishMismatches, zWishCreate } from './wishes';

const car: MatchableVehicle = {
  makeId: 'toyota',
  modelId: 'camry',
  modelYear: 2021,
  askingPrice: '95000.00',
  odometerValue: 30000,
  odometerUnit: 'mi',
  bodyType: 'sedan',
  fuelType: 'petrol',
  transmission: 'automatic',
  exteriorColor: 'Pearl White',
};

describe('wish matching', () => {
  it('matches when every given criterion is met', () => {
    expect(matchesWish({ makeId: 'toyota', yearFrom: 2020, yearTo: 2022, maxPrice: '95000', color: 'white' }, car)).toBe(true);
  });
  it('reports each failed criterion', () => {
    expect(wishMismatches({ modelId: 'corolla', yearFrom: 2022, maxPrice: '94999.99', bodyType: 'suv' }, car)).toEqual(['modelId', 'yearFrom', 'maxPrice', 'bodyType']);
  });
  it('converts miles before the odometer limit (30,000 mi ≈ 48,280 km)', () => {
    expect(matchesWish({ maxOdometerKm: 48_000 }, car)).toBe(false);
    expect(matchesWish({ maxOdometerKm: 48_300 }, car)).toBe(true);
  });
  it('never matches on missing data', () => {
    expect(matchesWish({ maxPrice: '200000' }, { ...car, askingPrice: null })).toBe(false);
    expect(matchesWish({ color: 'white' }, { ...car, exteriorColor: null })).toBe(false);
  });
  it('requires at least one criterion and ordered years', () => {
    const base = { customerId: '7d0d6d7e-3c43-4f0b-9b1a-2f5f8a1f0c11' };
    expect(zWishCreate.safeParse(base).success).toBe(false);
    expect(zWishCreate.safeParse({ ...base, yearFrom: 2023, yearTo: 2020 }).success).toBe(false);
    expect(zWishCreate.safeParse({ ...base, bodyType: 'suv' }).success).toBe(true);
  });
});
