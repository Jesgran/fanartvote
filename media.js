import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';

/** Valida e ricodifica: toglie metadati/EXIF, limita le dimensioni e salva in WebP. Lancia se il file non è un'immagine. */
export function encodeImage(buf) {
  return sharp(buf, { animated: true, limitInputPixels: 80e6 })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

export function writeMedia(file, data) {
  const dest = path.join(config.mediaDir, file);
  fs.writeFileSync(dest + '.tmp', data);
  fs.renameSync(dest + '.tmp', dest);
}
