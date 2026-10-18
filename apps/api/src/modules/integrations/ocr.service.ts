import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors';

export interface OcrResult {
  text: string;
  fields: Record<string, string>;
}

/** Document OCR: interface only. No provider is connected in this build (EXT-04). */
@Injectable()
export class OcrService {
  readonly available = false;

  extract(_file: Buffer, _mimeType: string): Promise<OcrResult> {
    return Promise.reject(new AppError('integration_not_available', HttpStatus.NOT_IMPLEMENTED, 'Document OCR is not connected'));
  }
}
