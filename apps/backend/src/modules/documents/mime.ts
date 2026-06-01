// Magic-byte MIME sniffer for the limited document set this module accepts.
// ----------------------------------------------------------------------------
// The browser-supplied Content-Type header is *only* a hint. We re-derive the
// MIME from the actual byte stream and reject the upload if:
//   - the sniffed type is null (unknown / unsupported), or
//   - the sniffed type disagrees with the header hint, or
//   - the sniffed type is not in ALLOWED_MIME.
//
// We deliberately keep this dependency-free: production systems should layer
// `file-type`/`mmmagic` on top, but the inline check below is enough to defeat
// the trivial "rename .exe to .pdf" attack and the equally trivial spoofed
// Content-Type. The patterns below are drawn from the file-format
// specifications cited inline.
//
// Supported set (locked by ALLOWED_MIME):
//   - application/pdf
//   - image/png
//   - image/jpeg
//   - image/webp
//   - image/heic
//   - application/vnd.openxmlformats-officedocument.wordprocessingml.document  (docx)
//   - application/vnd.openxmlformats-officedocument.spreadsheetml.sheet         (xlsx)
//
// docx/xlsx are ZIP containers; the magic bytes are PK\x03\x04. We can't
// distinguish them from a generic .zip without inspecting the central
// directory, so we accept the hint when the magic is ZIP and the hint is one
// of the two OOXML types. This is the documented "light-touch" path.

export const ALLOWED_MIME: Set<string> = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** Hard cap on uploaded file size (bytes). 10 MiB. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const OOXML_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const OOXML_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Map a sniffed MIME to a safe filesystem extension. */
export function mimeToExt(mime: string): string {
  switch (mime) {
    case 'application/pdf': return 'pdf';
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/heic': return 'heic';
    case OOXML_DOCX: return 'docx';
    case OOXML_XLSX: return 'xlsx';
    default: return 'bin';
  }
}

function startsWith(buf: Buffer, sig: number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false;
  }
  return true;
}

/**
 * Sniff the MIME from the first 12 bytes of the buffer.
 * Returns null if no signature matches.
 */
function sniff(buf: Buffer, hint: string): string | null {
  // %PDF-
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';

  // JPEG: FF D8 FF
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';

  // RIFF....WEBP — bytes 0..3 = "RIFF", bytes 8..11 = "WEBP"
  if (
    buf.length >= 12 &&
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }

  // HEIC/HEIF: bytes 4..7 = "ftyp", bytes 8..11 ∈ {"heic","heix","heim","heis","mif1","msf1","heif"}
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70
  ) {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1', 'heif'].includes(brand)) {
      return 'image/heic';
    }
  }

  // OOXML / ZIP: PK\x03\x04
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    // We cannot definitively distinguish docx vs xlsx without decompressing
    // the central directory and inspecting [Content_Types].xml. We trust the
    // header hint, but only when it is one of the two accepted OOXML types.
    if (hint === OOXML_DOCX) return OOXML_DOCX;
    if (hint === OOXML_XLSX) return OOXML_XLSX;
    return null;
  }

  return null;
}

export interface DetectResult {
  detected: string | null;
  allowed: boolean;
}

/**
 * Detect the MIME type from magic bytes and verify it matches the header hint
 * and is in the allow-list.
 */
export function detectMime(buf: Buffer, hintFromHeader: string): DetectResult {
  const detected = sniff(buf, hintFromHeader);
  if (detected === null) return { detected: null, allowed: false };
  if (detected !== hintFromHeader) return { detected, allowed: false };
  if (!ALLOWED_MIME.has(detected)) return { detected, allowed: false };
  return { detected, allowed: true };
}
