const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const TRANSFORMERS_CDN_URL = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
let extractorPromise = null;
let modelStatusPosted = false;
let transformersModulePromise = null;

function getErrorMessage(errorLike) {
  if (errorLike instanceof Error) return errorLike.message;
  if (typeof errorLike?.message === 'string' && errorLike.message.length > 0) return errorLike.message;
  return String(errorLike);
}

function postFatalError(message, details = null) {
  try {
    self.postMessage({
      type: 'worker_fatal',
      message,
      details,
    });
  } catch {
    // Ignore postMessage failures while reporting fatal worker errors.
  }
}

self.addEventListener('error', (event) => {
  postFatalError('Worker runtime error', {
    message: getErrorMessage(event?.error || event?.message || 'Unknown error event'),
    filename: event?.filename || null,
    lineno: Number.isFinite(event?.lineno) ? event.lineno : null,
    colno: Number.isFinite(event?.colno) ? event.colno : null,
  });
});

self.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason;
  postFatalError('Worker unhandled rejection', {
    message: getErrorMessage(reason),
    stack: reason instanceof Error ? reason.stack : null,
  });
});

async function getExtractor() {
  if (!extractorPromise) {
    if (!modelStatusPosted) {
      self.postMessage({ type: 'model_loading', modelId: MODEL_ID });
      modelStatusPosted = true;
    }
    if (!transformersModulePromise) {
      transformersModulePromise = (async () => {
        try {
          // Works in local dev where the bare specifier can be resolved by the dev server.
          return await import('@xenova/transformers');
        } catch (firstError) {
          console.warn('[worker] Local transformers import failed, falling back to CDN', {
            error: getErrorMessage(firstError),
            cdnUrl: TRANSFORMERS_CDN_URL,
          });
          // Works in production where worker bundles may preserve bare specifiers.
          return import(TRANSFORMERS_CDN_URL);
        }
      })();
    }

    const { pipeline, env } = await transformersModulePromise;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    console.log('[worker] Loading CLIP model', MODEL_ID);
    extractorPromise = pipeline('image-feature-extraction', MODEL_ID, {
      progress_callback: (progress) => {
        self.postMessage({
          type: 'model_download_progress',
          status: typeof progress?.status === 'string' ? progress.status : null,
          file: typeof progress?.file === 'string' ? progress.file : null,
          loaded:
            typeof progress?.loaded === 'number' && Number.isFinite(progress.loaded)
              ? progress.loaded
              : null,
          total:
            typeof progress?.total === 'number' && Number.isFinite(progress.total)
              ? progress.total
              : null,
          progress:
            typeof progress?.progress === 'number' && Number.isFinite(progress.progress)
              ? progress.progress
              : null,
        });
      },
    });
    await extractorPromise;
    console.log('[worker] CLIP model loaded');
    self.postMessage({ type: 'model_loaded', modelId: MODEL_ID });
  }
  return extractorPromise;
}

function squaredDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function meanColor(points) {
  if (points.length === 0) return [0, 0, 0];
  const acc = [0, 0, 0];
  for (const p of points) {
    acc[0] += p[0];
    acc[1] += p[1];
    acc[2] += p[2];
  }
  return [acc[0] / points.length, acc[1] / points.length, acc[2] / points.length];
}

function kMeansRGB(pixels, k = 2, iterations = 12) {
  if (pixels.length === 0) {
    return {
      dominantColors: [
        [0, 0, 0],
        [0, 0, 0],
      ],
      colorVector: new Array(6).fill(0),
    };
  }

  const centroids = [];
  const step = Math.max(1, Math.floor(pixels.length / k));
  for (let i = 0; i < k; i++) {
    centroids.push([...pixels[Math.min(i * step, pixels.length - 1)]]);
  }

  let clusters = new Array(pixels.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < pixels.length; i++) {
      let bestIndex = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dist = squaredDistance(pixels[i], centroids[c]);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = c;
        }
      }
      clusters[i] = bestIndex;
    }

    for (let c = 0; c < k; c++) {
      const clusterPoints = [];
      for (let i = 0; i < pixels.length; i++) {
        if (clusters[i] === c) clusterPoints.push(pixels[i]);
      }
      if (clusterPoints.length > 0) {
        centroids[c] = meanColor(clusterPoints);
      }
    }
  }

  const counts = new Array(k).fill(0);
  for (const clusterId of clusters) counts[clusterId] += 1;
  const ordered = [...Array(k).keys()].sort((a, b) => counts[b] - counts[a]);

  const dominantColors = ordered.map((idx) =>
    centroids[idx].map((v) => Math.max(0, Math.min(255, Math.round(v))))
  );
  while (dominantColors.length < 2) dominantColors.push([0, 0, 0]);

  const colorVector = dominantColors
    .flat()
    .map((value) => value / 255);

  return { dominantColors, colorVector };
}

async function extractDominantColors(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed image fetch for colors (${response.status})`);
  }
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);
  const size = 50;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imageBitmap, 0, 0, size, size);
  imageBitmap.close();

  const imageData = ctx.getImageData(0, 0, size, size).data;
  const pixels = [];
  for (let i = 0; i < imageData.length; i += 4) {
    const alpha = imageData[i + 3];
    if (alpha < 16) continue;
    pixels.push([imageData[i], imageData[i + 1], imageData[i + 2]]);
  }
  return kMeansRGB(pixels, 2, 12);
}

function normalizeEmbedding(raw) {
  const arr = Array.from(raw).slice(0, 512);
  while (arr.length < 512) arr.push(0);

  let norm = 0;
  for (const v of arr) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < arr.length; i++) arr[i] /= norm;
  }
  return arr;
}

async function extractClipEmbedding(imageUrl) {
  const extractor = await getExtractor();
  const output = await extractor(imageUrl, { pooling: 'mean', normalize: true });
  const raw = output?.data ?? output;
  return normalizeEmbedding(raw);
}

async function processItem(item) {
  const [embedding, colorData] = await Promise.all([
    extractClipEmbedding(item.thumbUrl),
    extractDominantColors(item.thumbUrl),
  ]);

  return {
    id: item.id,
    embedding,
    dominantColors: colorData.dominantColors,
    colorVector: colorData.colorVector,
  };
}

self.onmessage = async (event) => {
  const payload = event.data;
  if (!payload) return;

  if (payload.type === 'warmup_model') {
    try {
      await getExtractor();
      self.postMessage({ type: 'warmup_complete', modelId: MODEL_ID });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      postFatalError('Worker warmup failed', { message });
    }
    return;
  }

  if (payload.type !== 'process_batch') return;

  const { batchId, items } = payload;
  console.log('[worker] Processing batch', { batchId, size: items.length });
  const results = [];
  const errors = [];

  for (const item of items) {
    try {
      results.push(await processItem(item));
    } catch (error) {
      console.error('[worker] Item failed', {
        batchId,
        id: item.id,
        message: error instanceof Error ? error.message : String(error),
      });
      errors.push({
        id: item.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  self.postMessage({
    type: 'batch_complete',
    batchId,
    processedCount: items.length,
    results,
    errors,
  });
  console.log('[worker] Batch posted', {
    batchId,
    results: results.length,
    errors: errors.length,
  });
};
