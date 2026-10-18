import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { TenantContext } from '../../common/context';
import { AppError, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { IntegrationsService } from './integrations.service';

type VpicRow = Record<string, string | null>;

/**
 * VIN decoding through NHTSA vPIC (public, no key). Decoding only suggests field values for the
 * vehicle form; vehicle creation never depends on it. Timeouts and provider errors surface as 503
 * `integration_unavailable` so the user simply fills the fields in by hand.
 */
@Injectable()
export class VinDecoderService {
  private readonly logger = new Logger(VinDecoderService.name);
  /** Overridable for tests and private mirrors. */
  baseUrl = 'https://vpic.nhtsa.dot.gov/api';
  timeoutMs = 5_000;

  constructor(
    private readonly dbs: DbService,
    private readonly integrations: IntegrationsService,
  ) {}

  async decode(_ctx: TenantContext, rawVin: string) {
    const vin = rawVin.trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw unprocessable('invalid_vin', 'A VIN has 17 characters (no I, O or Q)', { field: 'vin' });
    const cfg = await this.integrations.resolve('vin_decoder');
    if (!cfg.enabled) throw new AppError('integration_disabled', HttpStatus.CONFLICT, 'VIN decoding is not enabled for this company');
    let row: VpicRow;
    try {
      const res = await fetch(`${this.baseUrl}/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { Results?: VpicRow[] };
      row = body.Results?.[0] ?? {};
    } catch (e) {
      this.logger.warn(`VIN decode failed: ${(e as Error).message}`);
      throw new AppError('integration_unavailable', HttpStatus.SERVICE_UNAVAILABLE, 'The VIN decoder is not responding; enter the details by hand');
    }
    const text = (k: string) => (row[k] && String(row[k]).trim() !== '' && row[k] !== 'Not Applicable' ? String(row[k]).trim() : null);
    const make = text('Make');
    const model = text('Model');
    // Map to the catalog where the names match exactly (case-insensitive); never create entries.
    const [mk] = make
      ? await this.dbs.query<{ id: string }>(`SELECT id FROM vehicle_makes WHERE lower(name_en) = lower($1) LIMIT 1`, [make])
      : [];
    const [md] = mk && model
      ? await this.dbs.query<{ id: string }>(`SELECT id FROM vehicle_models WHERE make_id = $1 AND lower(name_en) = lower($2) LIMIT 1`, [mk.id, model])
      : [];
    const year = Number(text('ModelYear'));
    return {
      source: 'nhtsa_vpic',
      vin,
      make,
      model,
      makeId: mk?.id ?? null,
      modelId: md?.id ?? null,
      modelYear: Number.isInteger(year) && year > 1900 ? year : null,
      trim: text('Trim'),
      bodyClass: text('BodyClass'),
      fuelType: text('FuelTypePrimary'),
      transmission: text('TransmissionStyle'),
      engine: [text('DisplacementL') && `${text('DisplacementL')} L`, text('EngineCylinders') && `${text('EngineCylinders')} cyl`].filter(Boolean).join(' ') || null,
      driveType: text('DriveType'),
      doors: text('Doors'),
      plantCountry: text('PlantCountry'),
      /** vPIC reports partial decodes through its error code ("0" = clean decode). */
      warnings: text('ErrorCode') && text('ErrorCode') !== '0' ? text('ErrorText') : null,
    };
  }
}
