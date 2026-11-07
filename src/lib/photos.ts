// Loads photos from a Cloudinary folder along with their camera settings (EXIF).
//
// Cloudinary's search API doesn't return EXIF, so each photo needs its own
// Admin API call. Those are rate limited (and the dev server re-renders on
// every reload), so results are cached on disk, keyed by public_id + version:
// re-uploading a photo gives it a new version and refreshes its entry.

import { v2 as cloudinary } from 'cloudinary';
import fs from 'node:fs/promises';
import path from 'node:path';

cloudinary.config({
  cloud_name: import.meta.env.PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key: import.meta.env.CLOUDINARY_API_KEY || process.env.CLOUDINARY_API_KEY,
  api_secret: import.meta.env.CLOUDINARY_API_SECRET || process.env.CLOUDINARY_API_SECRET,
});

export interface PhotoMeta {
  camera?: string;
  lens?: string;
  focalLength?: string;
  aperture?: string;
  shutter?: string;
  iso?: string;
  exposureComp?: string;
  size?: string;
}

export interface Photo {
  /** Small, compressed copy for the carousels (~800 px tall, a few hundred KB) */
  thumb: string;
  /** The original file exactly as uploaded, loaded only in the photo viewer */
  full: string;
  width: number;
  height: number;
  meta: PhotoMeta;
}

// Cloudinary resizes on the fly when options are added to the URL after /upload/:
// c_limit,h_800 = at most 800 px tall (never enlarged), f_auto = best format the
// browser supports (WebP/AVIF), q_auto = compression you can't see.
const THUMB_OPTIONS = 'c_limit,h_800/f_auto/q_auto';
const thumbUrl = (url: string) => url.replace('/upload/', `/upload/${THUMB_OPTIONS}/`);

const CACHE_FILE = path.join(process.cwd(), 'node_modules', '.cache', 'cloudinary-exif.json');
let cachePromise: Promise<Record<string, PhotoMeta>> | null = null;

function loadCache() {
  cachePromise ??= fs
    .readFile(CACHE_FILE, 'utf8')
    .then((text) => JSON.parse(text) as Record<string, PhotoMeta>)
    .catch(() => ({}));
  return cachePromise;
}

async function saveCache(cache: Record<string, PhotoMeta>) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache));
}

// Run `fn` over `items` with at most `limit` calls in flight
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// Returns the raw EXIF map, {} if the photo has none, or null if the call failed
async function fetchExif(publicId: string): Promise<Record<string, string> | null> {
  try {
    const res = await cloudinary.api.resource(publicId, { image_metadata: true });
    return res.image_metadata ?? {};
  } catch (error: any) {
    console.warn(`EXIF lookup failed for ${publicId}:`, error?.error?.message ?? error?.message ?? error);
    return null;
  }
}

// "NIKON" -> "Nikon", leaves "iPhone" / "Canon" alone
const tidyBrand = (word: string) =>
  word.length > 3 && word === word.toUpperCase() ? word[0] + word.slice(1).toLowerCase() : word;

function formatExif(m: Record<string, string> | null): PhotoMeta {
  if (!m) return {};
  const meta: PhotoMeta = {};

  if (m.Model) {
    const makeWord = (m.Make ?? '').split(' ')[0];
    let camera = m.Model;
    // Avoid "NIKON CORPORATION NIKON Z 7"
    if (makeWord && !camera.toUpperCase().startsWith(makeWord.toUpperCase())) camera = `${makeWord} ${camera}`;
    const [first, ...rest] = camera.split(' ');
    meta.camera = [tidyBrand(first), ...rest].join(' ');
  }

  const lens = m.LensModel || m.Lens;
  if (lens) meta.lens = lens;

  const focal = parseFloat(m.FocalLength);
  if (focal) meta.focalLength = `${+focal.toFixed(1)} mm`;

  const fNumber = parseFloat(m.FNumber);
  if (fNumber) meta.aperture = `ƒ/${+fNumber.toFixed(1)}`;

  if (m.ExposureTime) meta.shutter = `${m.ExposureTime} s`;
  if (m.ISO) meta.iso = `ISO ${m.ISO}`;
  if (m.ExposureCompensation && m.ExposureCompensation !== '0') meta.exposureComp = `${m.ExposureCompensation} EV`;

  return meta;
}

export async function getPhotos(folderName: string): Promise<Photo[]> {
  try {
    // Search returns at most 100 photos per call, so page through larger folders
    const resources: any[] = [];
    let cursor: string | undefined;
    do {
      let query = cloudinary.search
        .expression(`folder:"${folderName}"/*`) // quoted so names with spaces work
        .sort_by('public_id', 'desc')
        .max_results(100);
      if (cursor) query = query.next_cursor(cursor);
      const page = await query.execute();
      resources.push(...page.resources);
      cursor = page.next_cursor;
    } while (cursor);

    const cache = await loadCache();
    let changed = false;

    const photos = await mapLimit(resources, 6, async (file) => {
      const key = `${file.public_id}@${file.version}`;
      let meta = cache[key];
      if (!meta) {
        const exif = await fetchExif(file.public_id);
        meta = { ...formatExif(exif), size: `${file.width} × ${file.height}` };
        if (exif) { cache[key] = meta; changed = true; } // retry failures next time
      }
      const full = file.secure_url as string;
      return { thumb: thumbUrl(full), full, width: file.width, height: file.height, meta };
    });

    if (changed) await saveCache(cache).catch((e) => console.warn('Could not write EXIF cache:', e));
    return photos;
  } catch (error) {
    console.error(`Error fetching ${folderName}:`, error);
    return [];
  }
}
