import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import sharp, { type OverlayOptions } from "sharp";

export const ALLOWED_IMAGE_FORMATS = new Set(["jpeg", "png", "webp"]);
export const MAX_INPUT_PIXELS = 24_000_000;
export const MAX_IMAGE_DIMENSION = 1600;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_WATERMARK_LOGO_DIMENSION = 512;

export interface ImageValidationOptions {
  minWidth?: number;
  minHeight?: number;
}

/**
 * Validates raw image bytes using sharp and normalizes to a bounded WebP buffer.
 */
export async function validateAndNormalizeImage(
  buffer: Buffer,
  options: ImageValidationOptions = {},
): Promise<{ buffer: Buffer; width: number; height: number; format: string }> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Empty image buffer");
  }
  const image = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false });
  const meta = await image.metadata();
  if (
    !meta.format ||
    !ALLOWED_IMAGE_FORMATS.has(meta.format) ||
    (meta.pages ?? 1) > 1 ||
    !meta.width ||
    !meta.height
  ) {
    throw new Error("Invalid image format");
  }
  if (options.minWidth && meta.width < options.minWidth) {
    throw new Error(`Image width too small (${meta.width}px < ${options.minWidth}px)`);
  }
  if (options.minHeight && meta.height < options.minHeight) {
    throw new Error(`Image height too small (${meta.height}px < ${options.minHeight}px)`);
  }
  const normalized = await image
    .rotate()
    .resize({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 85 })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: normalized.data,
    width: normalized.info.width,
    height: normalized.info.height,
    format: "webp",
  };
}

/**
 * Persists a normalized WebP image as an immutable UUID-named blob inside product-images/.
 */
export async function saveProductImageBlob(
  dataDir: string,
  normalizedWebp: Buffer,
): Promise<{ id: string; path: string; cleanup: () => Promise<void> }> {
  const directory = resolve(dataDir, "product-images");
  mkdirSync(directory, { recursive: true });
  const id = randomUUID();
  const path = resolve(directory, `${id}.webp`);
  await writeFile(path, normalizedWebp, { flag: "wx", mode: 0o600 });
  return {
    id,
    path,
    cleanup: () => unlink(path).catch(() => {}),
  };
}

/**
 * Validates an uploaded watermark logo and normalizes it to a transparent PNG (<= 512px).
 */
export async function normalizeWatermarkLogo(
  buffer: Buffer,
): Promise<{ buffer: Buffer; mime: "image/png"; width: number; height: number }> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Empty image buffer");
  }
  const image = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false });
  const meta = await image.metadata();
  if (
    !meta.format ||
    !ALLOWED_IMAGE_FORMATS.has(meta.format) ||
    (meta.pages ?? 1) > 1 ||
    !meta.width ||
    !meta.height
  ) {
    throw new Error("Invalid image format");
  }
  const normalized = await image
    .rotate()
    .resize({
      width: MAX_WATERMARK_LOGO_DIMENSION,
      height: MAX_WATERMARK_LOGO_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: normalized.data,
    mime: "image/png",
    width: normalized.info.width,
    height: normalized.info.height,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function knockoutOuterWhite(rgba: Buffer, width: number, height: number): boolean {
  const total = width * height;
  if (total === 0) return false;

  // Skip images that already carry transparency along the outer perimeter.
  let transparentEdge = 0;
  let edgeCount = 0;
  const checkBorderPixel = (x: number, y: number) => {
    edgeCount++;
    if (rgba[(y * width + x) * 4 + 3]! < 250) transparentEdge++;
  };
  for (let x = 0; x < width; x++) {
    checkBorderPixel(x, 0);
    if (height > 1) checkBorderPixel(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    checkBorderPixel(0, y);
    if (width > 1) checkBorderPixel(width - 1, y);
  }
  if (transparentEdge / Math.max(1, edgeCount) >= 0.15) {
    return false;
  }

  const isNearWhite = (idx: number) => {
    const r = rgba[idx]!;
    const g = rgba[idx + 1]!;
    const b = rgba[idx + 2]!;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return min >= 232 && max - min <= 20;
  };

  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const enqueue = (x: number, y: number) => {
    const pos = y * width + x;
    if (visited[pos] || !isNearWhite(pos * 4)) return;
    visited[pos] = 1;
    queue[tail++] = pos;
  };

  for (let x = 0; x < width; x++) {
    enqueue(x, 0);
    if (height > 1) enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    enqueue(0, y);
    if (width > 1) enqueue(width - 1, y);
  }
  if (tail === 0) return false;

  while (head < tail) {
    const pos = queue[head++]!;
    const idx = pos * 4;
    const min = Math.min(rgba[idx]!, rgba[idx + 1]!, rgba[idx + 2]!);
    rgba[idx + 3] = min >= 246 ? 0 : Math.round(((246 - min) / 14) * 90);
    const x = pos % width;
    const y = (pos - x) / width;
    if (x > 0) enqueue(x - 1, y);
    if (x + 1 < width) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y + 1 < height) enqueue(x, y + 1);
  }
  return true;
}

async function prepareWatermarkOverlay(
  logoBuffer: Buffer,
  maxWidth: number,
  maxHeight: number,
): Promise<{ data: Buffer; width: number; height: number } | null> {
  let source = logoBuffer;
  try {
    const trimmed = await sharp(logoBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .trim({ threshold: 10 })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (trimmed.info.width >= 8 && trimmed.info.height >= 8) {
      source = trimmed.data;
    }
  } catch {
    // Keep original logo bytes if trim fails on flat-color inputs.
  }

  try {
    const raw = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .resize({
        width: Math.max(24, maxWidth),
        height: Math.max(24, maxHeight),
        fit: "inside",
        withoutEnlargement: true,
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    knockoutOuterWhite(raw.data, raw.info.width, raw.info.height);
    const pngData = await sharp(raw.data, {
      raw: { width: raw.info.width, height: raw.info.height, channels: 4 },
    })
      .png()
      .toBuffer();

    return { data: pngData, width: raw.info.width, height: raw.info.height };
  } catch {
    return null;
  }
}

async function sampleRegionLuminance(
  imageBuffer: Buffer,
  left: number,
  top: number,
  width: number,
  height: number,
): Promise<number> {
  try {
    const { data, info } = await sharp(imageBuffer)
      .extract({ left, top, width: Math.max(1, width), height: Math.max(1, height) })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const count = info.width * info.height;
    let sum = 0;
    for (let i = 0; i < data.length; i += 3) {
      sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    }
    return sum / Math.max(1, count);
  } catch {
    return 240;
  }
}

/**
 * Stamps the brand logo at top-right and `Code : <CODE>` cleanly at bottom-left
 * directly onto the processed image without altering its dimensions or adding boxes.
 */
export async function applyStudioCatalogStamp(
  imageBuffer: Buffer,
  options: {
    logoBuffer?: Buffer | null;
    productCode?: string | null;
  },
): Promise<Buffer> {
  const code = options.productCode?.trim() ?? "";
  const rawLogo = options.logoBuffer && options.logoBuffer.length > 0 ? options.logoBuffer : null;
  if (!code && !rawLogo) {
    return imageBuffer;
  }

  const base = await sharp(imageBuffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
    .rotate()
    .toBuffer({ resolveWithObject: true });

  const imgW = base.info.width;
  const imgH = base.info.height;
  const padX = Math.max(14, Math.round(imgW * 0.044));
  const padY = Math.max(14, Math.round(imgH * 0.038));

  const logoOverlay = rawLogo
    ? await prepareWatermarkOverlay(rawLogo, Math.round(imgW * 0.175), Math.round(imgH * 0.145))
    : null;

  if (!code && !logoOverlay) {
    return imageBuffer;
  }

  const composites: OverlayOptions[] = [];

  if (logoOverlay) {
    composites.push({
      input: logoOverlay.data,
      top: padY,
      left: Math.max(0, imgW - padX - logoOverlay.width),
    });
  }

  if (code) {
    const labelText = `Code : ${code}`;
    const minSide = Math.min(imgW, imgH);
    const fontSize = Math.max(14, Math.min(36, Math.round(minSide * 0.031)));
    const textBoxW = Math.min(imgW - padX, Math.max(40, Math.round(labelText.length * fontSize * 0.62)));
    const textBoxH = Math.min(imgH - padY, Math.max(16, Math.round(fontSize * 1.2)));
    const sampleLeft = Math.max(0, Math.min(imgW - 1, padX));
    const sampleTop = Math.max(0, Math.min(imgH - 1, imgH - padY - textBoxH));
    const avgLum = await sampleRegionLuminance(
      base.data,
      sampleLeft,
      sampleTop,
      Math.min(textBoxW, imgW - sampleLeft),
      Math.min(textBoxH, imgH - sampleTop),
    );
    const isLightBg = avgLum >= 130;
    const fillColor = isLightBg ? "#191918" : "#ffffff";
    const haloColor = isLightBg ? "rgba(255,255,255,0.72)" : "rgba(0,0,0,0.68)";
    const textY = imgH - padY;

    const textSvg = Buffer.from(
      `<svg width="${imgW}" height="${imgH}" viewBox="0 0 ${imgW} ${imgH}" xmlns="http://www.w3.org/2000/svg">
        <text x="${padX}" y="${textY}" font-family="Segoe UI, Arial, DejaVu Sans, Liberation Sans, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="0.6" fill="${fillColor}" stroke="${haloColor}" stroke-width="2.5" paint-order="stroke" text-anchor="start" dominant-baseline="alphabetic">${escapeXml(labelText)}</text>
      </svg>`,
    );
    composites.push({ input: textSvg, top: 0, left: 0 });
  }

  return sharp(base.data)
    .composite(composites)
    .webp({ quality: 88 })
    .toBuffer();
}
