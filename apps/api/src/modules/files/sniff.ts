/**
 * Content sniffing by magic bytes (never trust the client's Content-Type or extension) and
 * privacy scrubbing of photo metadata.
 */
export type SniffedType = { mime: string; ext: string; kind: 'image' | 'pdf' | 'video' };

export function sniff(buf: Buffer): SniffedType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png', kind: 'image' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  }
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf', kind: 'pdf' };
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'qt  ') return { mime: 'video/quicktime', ext: 'mov', kind: 'video' };
    if (['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'MSNV'].includes(brand)) {
      return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
    }
  }
  return null;
}

/**
 * Removes GPS coordinates and XMP/Photoshop/comment segments from a JPEG while keeping the
 * EXIF orientation, so published photos do not leak where they were taken.
 */
export function scrubJpeg(input: Buffer): Buffer {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return input;
  const out: Buffer[] = [input.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= input.length) {
    if (input[i] !== 0xff) return input; // malformed — leave untouched rather than corrupt
    const marker = input[i + 1]!;
    if (marker === 0xda) {
      out.push(input.subarray(i));
      return Buffer.concat(out);
    }
    if (marker === 0xd9) {
      out.push(input.subarray(i));
      return Buffer.concat(out);
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      out.push(input.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = input.readUInt16BE(i + 2);
    const seg = Buffer.from(input.subarray(i, i + 2 + len));
    const payload = seg.subarray(4);
    const isExif = marker === 0xe1 && payload.subarray(0, 6).toString('binary') === 'Exif\0\0';
    const isXmp = marker === 0xe1 && !isExif;
    if (isXmp || marker === 0xed || marker === 0xfe) {
      i += 2 + len; // drop XMP, Photoshop IRB and comments
      continue;
    }
    if (isExif) stripGpsFromTiff(seg, 4 + 6);
    out.push(seg);
    i += 2 + len;
  }
  return input;
}

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** Zeroes the GPS IFD (entries and out-of-line values) and unlinks it from IFD0, in place. */
function stripGpsFromTiff(seg: Buffer, tiffStart: number): void {
  try {
    const le = seg.toString('binary', tiffStart, tiffStart + 2) === 'II';
    const u16 = (o: number) => (le ? seg.readUInt16LE(tiffStart + o) : seg.readUInt16BE(tiffStart + o));
    const u32 = (o: number) => (le ? seg.readUInt32LE(tiffStart + o) : seg.readUInt32BE(tiffStart + o));
    const ifd0 = u32(4);
    const n = u16(ifd0);
    for (let e = 0; e < n; e++) {
      const entry = ifd0 + 2 + e * 12;
      if (u16(entry) !== 0x8825) continue;
      const gps = u32(entry + 8);
      const gn = u16(gps);
      for (let g = 0; g < gn; g++) {
        const ge = gps + 2 + g * 12;
        const size = (TYPE_SIZES[u16(ge + 2)] ?? 1) * u32(ge + 4);
        if (size > 4) seg.fill(0, tiffStart + u32(ge + 8), tiffStart + u32(ge + 8) + size);
      }
      seg.fill(0, tiffStart + gps + 2, tiffStart + gps + 2 + gn * 12);
      seg.fill(0, tiffStart + entry, tiffStart + entry + 12); // remove the pointer tag itself
    }
  } catch {
    /* Malformed EXIF: leave as-is; upload still proceeds. */
  }
}

/** Drops textual and EXIF chunks from PNG files. */
export function scrubPng(input: Buffer): Buffer {
  const sig = input.subarray(0, 8);
  const out: Buffer[] = [sig];
  let i = 8;
  while (i + 12 <= input.length) {
    const len = input.readUInt32BE(i);
    const type = input.toString('ascii', i + 4, i + 8);
    const chunk = input.subarray(i, i + 12 + len);
    if (!['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(type)) out.push(chunk);
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}
