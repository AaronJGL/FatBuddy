import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const sourceIcon = join(publicDirectory, 'icon.svg');
const iconSizes = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
];

await Promise.all(iconSizes.map(([filename, size]) => (
  sharp(sourceIcon)
    .resize(size, size)
    .png()
    .toFile(join(publicDirectory, filename))
)));