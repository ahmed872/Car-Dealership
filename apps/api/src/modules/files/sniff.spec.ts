import { describe, expect, it } from 'vitest';
import { scrubJpeg, scrubPng, sniff } from './sniff';

/** Builds a JPEG with an EXIF APP1 containing Orientation in IFD0 and a GPS IFD with a latitude. */
function jpegWithGps(): { buf: Buffer; gpsLatOffset: number } {
  const tiff = Buffer.alloc(80);
  tiff.write('II', 0, 'binary');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 at 8
  tiff.writeUInt16LE(2, 8); // two entries
  // Orientation (0x0112) SHORT 1 = 6
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(6, 18);
  // GPS pointer (0x8825) LONG -> 38
  tiff.writeUInt16LE(0x8825, 22);
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt32LE(38, 30);
  tiff.writeUInt32LE(0, 34); // next IFD
  // GPS IFD at 38: one entry GPSLatitude RATIONAL x3 -> data at 56 (24 bytes)
  tiff.writeUInt16LE(1, 38);
  tiff.writeUInt16LE(0x0002, 40);
  tiff.writeUInt16LE(5, 42);
  tiff.writeUInt32LE(3, 44);
  tiff.writeUInt32LE(56, 48);
  tiff.writeUInt32LE(0, 52);
  for (let i = 0; i < 6; i++) tiff.writeUInt32LE(0x11111111, 56 + i * 4);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, 0]), payload]);
  app1.writeUInt16BE(payload.length + 2, 2);
  const xmpPayload = Buffer.from('http://ns.adobe.com/xap/1.0/\0abc', 'binary');
  const xmp = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x00]), xmpPayload]);
  xmp.writeUInt16BE(xmpPayload.length + 2, 2);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x12, 0x34, 0xff, 0xd9]);
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, xmp, sos]);
  // offset of GPS latitude data inside the final buffer: SOI(2)+marker(2)+len(2)+Exif(6)+56
  return { buf, gpsLatOffset: 2 + 4 + 6 + 56 };
}

describe('file sniffing', () => {
  it('detects real types regardless of name', () => {
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe('image/jpeg');
    expect(sniff(Buffer.from('%PDF-1.7'))?.kind).toBe('pdf');
    expect(sniff(Buffer.from('<html>'))).toBeNull();
    const mp4 = Buffer.alloc(12);
    mp4.write('ftypisom', 4, 'ascii');
    expect(sniff(mp4)?.mime).toBe('video/mp4');
  });

  it('removes GPS data and XMP but keeps orientation', () => {
    const { buf, gpsLatOffset } = jpegWithGps();
    expect(buf.readUInt32LE(gpsLatOffset)).toBe(0x11111111);
    const out = scrubJpeg(buf);
    // XMP segment dropped
    expect(out.includes(Buffer.from('http://ns.adobe.com/xap/1.0/'))).toBe(false);
    // GPS rational values zeroed
    expect(out.readUInt32LE(gpsLatOffset)).toBe(0);
    // GPS pointer tag removed, orientation (6) still present in IFD0
    const tiffStart = 2 + 4 + 6;
    expect(out.readUInt16LE(tiffStart + 10)).toBe(0x0112);
    expect(out.readUInt16LE(tiffStart + 18)).toBe(6);
    expect(out.readUInt16LE(tiffStart + 22)).toBe(0);
    expect(out.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it('drops PNG text and EXIF chunks', () => {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
    };
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', Buffer.alloc(13)),
      chunk('tEXt', Buffer.from('GPS\0secret')),
      chunk('eXIf', Buffer.from('xx')),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const out = scrubPng(png);
    expect(out.includes(Buffer.from('secret'))).toBe(false);
    expect(out.includes(Buffer.from('IEND'))).toBe(true);
  });
});
