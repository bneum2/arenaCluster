import { PCA } from 'ml-pca';
import { UMAP } from 'umap-js';

const ARENA_BASE_URL = 'https://api.are.na/v2';
const FETCH_RETRY_LIMIT = 3;
const FETCH_RETRY_BASE_DELAY_MS = 600;
const FETCH_TIMEOUT_MS = 15000;
const RECENT_CHANNEL_CACHE_LIMIT = 10;
const recentChannelEmbeddingCache = new Map();
const IMAGE_EMBEDDING_CACHE_LIMIT = 5000;
const recentImageEmbeddingCache = new Map();
const CHANNEL_EMBEDDING_DB_NAME = 'arena-cluster-cache';
const CHANNEL_EMBEDDING_STORE = 'channel-embeddings';
const CHANNEL_EMBEDDING_DB_VERSION = 1;
let channelEmbeddingDbPromise = null;

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function mapArenaError(status) {
  if (status === 401 || status === 403) {
    return 'This channel appears private. Only public channels are supported.';
  }
  if (status === 404) {
    return 'Channel not found. Check the URL or slug and try again.';
  }
  if (status === 429) {
    return 'Are.na rate limit reached. Wait a moment and retry.';
  }
  return `Are.na request failed (${status}).`;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeChannelCacheKey(slug) {
  const trimmed = safeText(slug).trim().toLowerCase();
  return trimmed || null;
}

function getCachedChannelEmbeddings(cacheKey) {
  if (!cacheKey) return null;
  const cached = recentChannelEmbeddingCache.get(cacheKey);
  if (!cached) return null;
  // Touch key to preserve LRU ordering for most recently used channels.
  recentChannelEmbeddingCache.delete(cacheKey);
  recentChannelEmbeddingCache.set(cacheKey, cached);
  return cached;
}

function setCachedChannelEmbeddings(cacheKey, workerResults) {
  if (!cacheKey || !Array.isArray(workerResults) || workerResults.length === 0) return;
  const byId = new Map(workerResults.map((item) => [item.id, item]));
  recentChannelEmbeddingCache.delete(cacheKey);
  recentChannelEmbeddingCache.set(cacheKey, byId);
  while (recentChannelEmbeddingCache.size > RECENT_CHANNEL_CACHE_LIMIT) {
    const oldestSlug = recentChannelEmbeddingCache.keys().next().value;
    recentChannelEmbeddingCache.delete(oldestSlug);
  }

  // Also seed global per-image cache so reuse still works
  // when channel-keyed lookup misses for any reason.
  for (const result of workerResults) {
    if (!result?.id) continue;
    recentImageEmbeddingCache.delete(result.id);
    recentImageEmbeddingCache.set(result.id, result);
  }
  while (recentImageEmbeddingCache.size > IMAGE_EMBEDDING_CACHE_LIMIT) {
    const oldestImageId = recentImageEmbeddingCache.keys().next().value;
    recentImageEmbeddingCache.delete(oldestImageId);
  }
}

function openChannelEmbeddingDb() {
  if (typeof indexedDB === 'undefined') return null;
  if (!channelEmbeddingDbPromise) {
    channelEmbeddingDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(CHANNEL_EMBEDDING_DB_NAME, CHANNEL_EMBEDDING_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CHANNEL_EMBEDDING_STORE)) {
          db.createObjectStore(CHANNEL_EMBEDDING_STORE, { keyPath: 'slug' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return channelEmbeddingDbPromise;
}

async function readPersistentChannelEmbeddings(cacheKey) {
  if (!cacheKey) return null;
  const dbPromise = openChannelEmbeddingDb();
  if (!dbPromise) return null;
  try {
    const db = await dbPromise;
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(CHANNEL_EMBEDDING_STORE, 'readonly');
      const store = tx.objectStore(CHANNEL_EMBEDDING_STORE);
      const request = store.get(cacheKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    if (!record || !Array.isArray(record.items) || record.items.length === 0) return null;
    return new Map(record.items.map((item) => [item.id, item]));
  } catch (err) {
    console.warn('[pipeline] Failed reading persistent embedding cache', {
      slug: cacheKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function writePersistentChannelEmbeddings(cacheKey, workerResults) {
  if (!cacheKey || !Array.isArray(workerResults) || workerResults.length === 0) return;
  const dbPromise = openChannelEmbeddingDb();
  if (!dbPromise) return;
  try {
    const db = await dbPromise;
    const now = Date.now();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CHANNEL_EMBEDDING_STORE, 'readwrite');
      const store = tx.objectStore(CHANNEL_EMBEDDING_STORE);
      store.put({
        slug: cacheKey,
        updatedAt: now,
        items: workerResults,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Keep persistent store bounded by LRU-style updatedAt.
    const allRecords = await new Promise((resolve, reject) => {
      const tx = db.transaction(CHANNEL_EMBEDDING_STORE, 'readonly');
      const store = tx.objectStore(CHANNEL_EMBEDDING_STORE);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    if (allRecords.length <= RECENT_CHANNEL_CACHE_LIMIT) return;

    const sorted = [...allRecords].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    const toDelete = sorted.slice(0, allRecords.length - RECENT_CHANNEL_CACHE_LIMIT);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CHANNEL_EMBEDDING_STORE, 'readwrite');
      const store = tx.objectStore(CHANNEL_EMBEDDING_STORE);
      for (const record of toDelete) {
        if (record?.slug) store.delete(record.slug);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[pipeline] Failed writing persistent embedding cache', {
      slug: cacheKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function fetchPageWithRetry({ url, page, signal }) {
  let attempts = 0;
  while (attempts < FETCH_RETRY_LIMIT) {
    attempts += 1;
    try {
      const requestController = new AbortController();
      let timeoutTriggered = false;
      const timeoutId = setTimeout(() => {
        timeoutTriggered = true;
        requestController.abort();
      }, FETCH_TIMEOUT_MS);
      const relayAbort = () => requestController.abort();
      signal?.addEventListener('abort', relayAbort, { once: true });

      let response;
      try {
        response = await fetch(url, { signal: requestController.signal });
      } catch (err) {
        if (timeoutTriggered) {
          const timeoutError = new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms`);
          timeoutError.timeout = true;
          throw timeoutError;
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', relayAbort);
      }

      if (response.ok) {
        return { data: await response.json(), skipped: false };
      }

      if (!isTransientStatus(response.status)) {
        console.error('[pipeline] Fetch failed', { page, status: response.status });
        const permanentError = new Error(mapArenaError(response.status));
        permanentError.permanent = true;
        throw permanentError;
      }

      const remaining = FETCH_RETRY_LIMIT - attempts;
      if (remaining <= 0) {
        console.warn('[pipeline] Skipping page after retries', {
          page,
          status: response.status,
          attempts,
        });
        return { data: null, skipped: true };
      }

      const waitMs = FETCH_RETRY_BASE_DELAY_MS * attempts;
      console.warn('[pipeline] Retrying page fetch', {
        page,
        status: response.status,
        attempts,
        waitMs,
      });
      await delay(waitMs);
    } catch (err) {
      if (err?.permanent) throw err;
      if (err?.timeout) {
        const remaining = FETCH_RETRY_LIMIT - attempts;
        if (remaining <= 0) {
          console.warn('[pipeline] Skipping page after timeout retries', {
            page,
            attempts,
          });
          return { data: null, skipped: true };
        }
        const waitMs = FETCH_RETRY_BASE_DELAY_MS * attempts;
        console.warn('[pipeline] Retrying page after timeout', {
          page,
          attempts,
          waitMs,
        });
        await delay(waitMs);
        continue;
      }
      if (isAbortError(err)) throw err;
      const remaining = FETCH_RETRY_LIMIT - attempts;
      if (remaining <= 0) {
        console.warn('[pipeline] Skipping page after network retries', {
          page,
          attempts,
          error: err instanceof Error ? err.message : String(err),
        });
        return { data: null, skipped: true };
      }
      const waitMs = FETCH_RETRY_BASE_DELAY_MS * attempts;
      console.warn('[pipeline] Retrying page after network error', {
        page,
        attempts,
        waitMs,
        error: err instanceof Error ? err.message : String(err),
      });
      await delay(waitMs);
    }
  }

  return { data: null, skipped: true };
}

export function parseArenaSlug(input) {
  const trimmed = safeText(input).trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('http')) return trimmed;

  try {
    const url = new URL(trimmed);
    if (!url.hostname.includes('are.na')) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    if (parts[0] === 'channel' && parts[1]) return parts[1];
    return parts[parts.length - 1];
  } catch {
    return null;
  }
}

export async function fetchArenaImageBlocks({ slug, onProgress, onImageBatch, signal }) {
  const per = 100;
  let page = 1;
  let total = null;
  let processedBlocks = 0;
  let skippedPages = 0;
  const images = [];

  console.log('[pipeline] Fetch start', { slug });
  while (true) {
    const url = `${ARENA_BASE_URL}/channels/${encodeURIComponent(slug)}?per=${per}&page=${page}`;
    onProgress?.({
      stage: 'fetch',
      message: `Fetching channel blocks... (page ${page})`,
      completed: processedBlocks,
      total: total ?? undefined,
      page,
    });
    const { data, skipped } = await fetchPageWithRetry({ url, page, signal });
    if (skipped) {
      if (total == null) {
        throw new Error('Unable to fetch channel blocks. Please retry.');
      }
      skippedPages += 1;
      onProgress?.({
        stage: 'fetch',
        message: `Network hiccup on page ${page}; skipping and continuing...`,
        completed: processedBlocks,
        total: total ?? undefined,
        page,
      });
      const maxPages = Math.max(1, Math.ceil(total / per));
      if (page >= maxPages) break;
      page += 1;
      continue;
    }

    const contents = Array.isArray(data.contents) ? data.contents : [];
    total = typeof data.length === 'number' ? data.length : total;
    processedBlocks += contents.length;

    const imageBlocks = contents
      .filter((block) => block?.class === 'Image')
      .map((block) => ({
        id: String(block.id),
        thumbUrl:
          block?.image?.thumb?.url ||
          block?.image?.square?.url ||
          block?.image?.display?.url ||
          block?.image?.large?.url ||
          null,
        originalUrl:
          block?.image?.original?.url ||
          block?.image?.display?.url ||
          block?.image?.large?.url ||
          block?.image?.thumb?.url ||
          null,
        title: safeText(block.title),
        description: safeText(block.description),
        sourceUrl: safeText(block?.source?.url),
        createdAt: safeText(block.created_at),
      }))
      .filter((item) => item.thumbUrl && item.originalUrl);

    images.push(...imageBlocks);
    onImageBatch?.(imageBlocks);
    console.log('[pipeline] Page fetched', {
      page,
      pageBlocks: contents.length,
      totalBlocks: total,
      processedBlocks,
      imageCount: images.length,
    });

    onProgress?.({
      stage: 'fetch',
      message:
        skippedPages > 0
          ? `Fetching channel blocks... (${images.length} images found, ${skippedPages} page${skippedPages === 1 ? '' : 's'} skipped)`
          : `Fetching channel blocks... (${images.length} images found)`,
      completed: processedBlocks,
      total: total ?? undefined,
      page,
    });

    if (contents.length < per) break;
    if (total != null && page * per >= total) break;
    page += 1;
  }

  if (images.length === 0) {
    throw new Error('This channel has no image blocks to cluster.');
  }

  console.log('[pipeline] Fetch complete', { imageCount: images.length });
  return images;
}

function normalizeCoordinates(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  return points.map(([x, y]) => [(x - minX) / rangeX, (y - minY) / rangeY]);
}

function estimateEta(startMs, completed, total) {
  if (!total || completed <= 0) return null;
  const elapsed = (Date.now() - startMs) / 1000;
  const rate = completed / elapsed;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.max(0, Math.round((total - completed) / rate));
}

function buildEpochSampleSet(totalEpochs, sampleCount) {
  const count = Math.max(1, Math.min(sampleCount, totalEpochs));
  const sampled = new Set();
  for (let i = 0; i < count; i += 1) {
    const ratio = count === 1 ? 1 : i / (count - 1);
    const epoch = Math.max(1, Math.round(ratio * (totalEpochs - 1)) + 1);
    sampled.add(epoch);
  }
  sampled.add(totalEpochs);
  return sampled;
}

function normalizeEmbeddingVector(rawEmbedding, expectedLength) {
  if (!Array.isArray(rawEmbedding)) {
    return Array(expectedLength).fill(0);
  }
  if (rawEmbedding.length === expectedLength) {
    return rawEmbedding;
  }
  const normalized = rawEmbedding.slice(0, expectedLength);
  while (normalized.length < expectedLength) {
    normalized.push(0);
  }
  return normalized;
}

function describeWorkerErrorEvent(event) {
  const directMessage =
    typeof event?.message === 'string' && event.message.trim().length > 0
      ? event.message.trim()
      : null;
  const nestedErrorMessage =
    typeof event?.error?.message === 'string' && event.error.message.trim().length > 0
      ? event.error.message.trim()
      : null;
  const fileHint =
    typeof event?.filename === 'string' && event.filename.trim().length > 0
      ? event.filename.split('/').pop()
      : null;
  const lineHint = Number.isFinite(event?.lineno) && event.lineno > 0 ? event.lineno : null;
  const columnHint = Number.isFinite(event?.colno) && event.colno > 0 ? event.colno : null;
  const locationHint =
    fileHint && lineHint != null
      ? `${fileHint}:${lineHint}${columnHint != null ? `:${columnHint}` : ''}`
      : fileHint;
  const fallbackDetails =
    typeof event?.data === 'string' && event.data.trim().length > 0 ? event.data.trim() : null;

  const message =
    directMessage ||
    nestedErrorMessage ||
    fallbackDetails ||
    (locationHint ? `Worker runtime error at ${locationHint}` : null) ||
    'Unknown worker runtime error.';

  return {
    message,
    locationHint,
    stack: typeof event?.error?.stack === 'string' ? event.error.stack : null,
  };
}

function buildWorkerFailureMessage(info, workerUrl) {
  const base = info?.message || 'Unknown worker runtime error.';
  const likelyStartupFailure =
    base === 'Unknown worker runtime error.' || base.startsWith('Worker runtime error at ');

  if (!likelyStartupFailure) {
    return `Worker error: ${base}`;
  }

  return `Worker failed to initialize: ${base} This is often caused by blocked worker/module requests in production (CSP, ad blockers, or cross-origin asset paths). Worker URL: ${workerUrl}`;
}

async function runWorkerPool({
  items,
  workerCount,
  batchSize,
  onProgress,
  signal,
  progressOffset = 0,
  progressTotal = items.length,
}) {
  const ordered = new Map(items.map((item) => [item.id, null]));
  const workerUrl = new URL('../workers/clipWorker.js', import.meta.url);
  const workers = [];
  const batches = [];
  const errors = [];

  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  console.log('[pipeline] Worker pool init', {
    items: items.length,
    workerCount,
    batchSize,
    batches: batches.length,
  });

  const startedAt = Date.now();
  let modelLoading = false;
  let nextBatchIndex = 0;
  let finishedCount = 0;

  function updateProgress() {
    const completed = Math.min(progressTotal, progressOffset + finishedCount);
    onProgress?.({
      stage: 'embed',
      message: modelLoading
        ? `Generating embeddings... (${completed} / ${progressTotal}) Downloading CLIP model cache...`
        : `Generating embeddings... (${completed} / ${progressTotal})`,
      completed,
      total: progressTotal,
      etaSeconds: estimateEta(startedAt, completed, progressTotal),
      modelLoading,
    });
  }

  updateProgress();

  async function startWorker() {
    const worker = new Worker(workerUrl, { type: 'module' });
    workers.push(worker);

    await new Promise((resolve, reject) => {
      const startupTimeoutMs = 15000;
      const startupTimeout = setTimeout(() => {
        reject(
          new Error(
            `Worker failed to initialize within ${startupTimeoutMs}ms. This is often caused by blocked worker/module requests in production (CSP, ad blockers, or cross-origin asset paths). Worker URL: ${workerUrl.href}`
          )
        );
      }, startupTimeoutMs);
      const clearStartupTimeout = () => clearTimeout(startupTimeout);

      const assignNext = () => {
        if (signal?.aborted) {
          clearStartupTimeout();
          reject(new Error('Pipeline cancelled.'));
          return;
        }
        if (nextBatchIndex >= batches.length) {
          clearStartupTimeout();
          resolve();
          return;
        }

        const localBatchId = nextBatchIndex;
        const batch = batches[nextBatchIndex];
        nextBatchIndex += 1;
        console.log('[pipeline] Assigning batch', {
          batchId: localBatchId,
          size: batch.length,
          assigned: nextBatchIndex,
          totalBatches: batches.length,
        });
        worker.postMessage({ type: 'process_batch', batchId: localBatchId, items: batch });
      };

      worker.onmessage = (event) => {
        clearStartupTimeout();
        const msg = event.data;
        if (msg?.type === 'model_loading') {
          modelLoading = true;
          console.log('[pipeline] Worker model loading');
          updateProgress();
          return;
        }
        if (msg?.type === 'model_loaded') {
          modelLoading = false;
          console.log('[pipeline] Worker model loaded');
          updateProgress();
          return;
        }
        if (msg?.type !== 'batch_complete') return;
        console.log('[pipeline] Batch complete', {
          batchId: msg.batchId,
          processedCount: msg.processedCount,
          resultCount: (msg.results || []).length,
          errorCount: (msg.errors || []).length,
        });

        for (const result of msg.results || []) {
          ordered.set(result.id, result);
        }
        for (const err of msg.errors || []) {
          errors.push(err);
        }
        finishedCount += msg.processedCount || 0;
        updateProgress();
        assignNext();
      };

      worker.onerror = (event) => {
        const info = describeWorkerErrorEvent(event);
        console.error('[pipeline] Worker error event', {
          message: info.message,
          location: info.locationHint,
          stack: info.stack,
          workerUrl: workerUrl.href,
          rawEvent: event,
        });
        clearStartupTimeout();
        reject(new Error(buildWorkerFailureMessage(info, workerUrl.href)));
      };

      worker.onmessageerror = (event) => {
        console.error('[pipeline] Worker message parse error', event);
        clearStartupTimeout();
        reject(new Error('Worker message error: failed to parse worker response payload.'));
      };

      assignNext();
    });
  }

  try {
    const count = Math.max(1, Math.min(workerCount, batches.length || 1));
    await Promise.all(new Array(count).fill(0).map(() => startWorker()));
  } finally {
    workers.forEach((worker) => worker.terminate());
  }

  if (signal?.aborted) {
    throw new Error('Pipeline cancelled.');
  }

  const results = items
    .map((item) => ordered.get(item.id))
    .filter(Boolean);

  if (results.length === 0) {
    throw new Error('No image embeddings were generated.');
  }

  if (errors.length > 0) {
    console.warn(`Worker processing skipped ${errors.length} images due to errors.`);
  }

  console.log('[pipeline] Worker pool complete', {
    processed: results.length,
    workerErrors: errors.length,
  });
  return results;
}

export async function runArenaImagePipeline({
  slug,
  workerCount = 4,
  batchSize = 8,
  onProgress,
  onImageBatch,
  onLayoutSnapshot,
  signal,
}) {
  console.log('[pipeline] Run started', { slug, workerCount, batchSize });
  const startedAt = Date.now();
  const cacheKey = normalizeChannelCacheKey(slug);
  const images = await fetchArenaImageBlocks({
    slug,
    signal,
    onProgress,
    onImageBatch,
  });

  let cachedById = getCachedChannelEmbeddings(cacheKey);
  if (!cachedById) {
    cachedById = await readPersistentChannelEmbeddings(cacheKey);
    if (cachedById) {
      recentChannelEmbeddingCache.delete(cacheKey);
      recentChannelEmbeddingCache.set(cacheKey, cachedById);
      console.log('[pipeline] Loaded embeddings from persistent cache', {
        slug: cacheKey,
        cached: cachedById.size,
      });
    }
  }
  const cachedWorkerResults = [];
  const uncachedImages = [];
  if (cachedById) {
    for (const image of images) {
      const cached = cachedById.get(image.id);
      if (cached) {
        cachedWorkerResults.push(cached);
      } else {
        uncachedImages.push(image);
      }
    }
  } else {
    uncachedImages.push(...images);
  }

  // Fallback reuse: pull any misses from global image cache.
  if (uncachedImages.length > 0) {
    const stillUncached = [];
    for (const image of uncachedImages) {
      const cached = recentImageEmbeddingCache.get(image.id);
      if (cached) {
        cachedWorkerResults.push(cached);
      } else {
        stillUncached.push(image);
      }
    }
    uncachedImages.length = 0;
    uncachedImages.push(...stillUncached);
  }

  if (cachedWorkerResults.length > 0) {
    const uncachedCount = Math.max(0, images.length - cachedWorkerResults.length);
    onProgress?.({
      stage: 'embed',
      message:
        uncachedCount > 0
          ? `Reusing cached embeddings for ${cachedWorkerResults.length} images. Generating ${uncachedCount} new embeddings...`
          : `Reusing cached embeddings for all ${images.length} images. Skipping regeneration...`,
      completed: cachedWorkerResults.length,
      total: images.length,
      etaSeconds: estimateEta(startedAt, cachedWorkerResults.length, images.length),
      modelLoading: false,
    });
    console.log('[pipeline] Reusing cached channel embeddings', {
      slug,
      cached: cachedWorkerResults.length,
      total: images.length,
    });
  }

  const newWorkerResults =
    uncachedImages.length > 0
      ? await runWorkerPool({
          items: uncachedImages,
          workerCount,
          batchSize,
          onProgress,
          signal,
          progressOffset: cachedWorkerResults.length,
          progressTotal: images.length,
        })
      : [];
  const workerResults = [...cachedWorkerResults, ...newWorkerResults];
  setCachedChannelEmbeddings(cacheKey, workerResults);
  await writePersistentChannelEmbeddings(cacheKey, workerResults);

  onProgress?.({
    stage: 'color',
    message: 'Extracting colors...',
    completed: workerResults.length,
    total: workerResults.length,
  });
  console.log('[pipeline] Color features stage complete', { count: workerResults.length });

  const byId = new Map(workerResults.map((result) => [result.id, result]));
  const successfulImages = images.filter((image) => byId.has(image.id));
  const firstEmbeddingLength = byId.get(successfulImages[0]?.id)?.embedding?.length;
  const embeddingLength =
    typeof firstEmbeddingLength === 'number' && firstEmbeddingLength > 0 ? firstEmbeddingLength : 512;
  const clipEmbeddings = successfulImages.map((item) =>
    normalizeEmbeddingVector(byId.get(item.id).embedding, embeddingLength)
  );
  const colorVectors = successfulImages.map((item) => byId.get(item.id).colorVector);

  onProgress?.({ stage: 'pca', message: 'Running PCA...' });
  console.log('[pipeline] PCA start', { vectors: clipEmbeddings.length, dims: embeddingLength });

  let reducedClip;
  const sampleCount = clipEmbeddings.length;
  const maxRequestedComponents = 50;
  if (sampleCount <= 1) {
    reducedClip = clipEmbeddings.map((embedding) => embedding.slice(0, 1));
    console.log('[pipeline] PCA skipped', { reason: 'insufficient_samples', vectors: sampleCount, dims: 1 });
  } else {
    const pca = new PCA(clipEmbeddings, { center: true, scale: false });
    const predicted = pca.predict(clipEmbeddings).to2DArray();
    const availableComponents = predicted[0]?.length || 1;
    const componentCount = Math.max(1, Math.min(maxRequestedComponents, availableComponents));
    reducedClip = predicted.map((row) => row.slice(0, componentCount));
    console.log('[pipeline] PCA complete', {
      vectors: reducedClip.length,
      dims: componentCount,
      availableComponents,
    });
  }

  const combinedVectors = reducedClip.map((clip, index) => [...clip, ...colorVectors[index]]);
  onProgress?.({ stage: 'umap', message: 'Running UMAP layout...', completed: 0, total: 1 });
  console.log('[pipeline] UMAP start', {
    vectors: combinedVectors.length,
    dims: combinedVectors[0]?.length || 0,
  });

  function emitLayoutSnapshot(coords, epoch, totalEpochs) {
    const normalized = normalizeCoordinates(coords);
    onLayoutSnapshot?.(
      successfulImages.map((item, index) => ({
        id: item.id,
        x: normalized[index][0],
        y: normalized[index][1],
      }))
    );
    onProgress?.({
      stage: 'umap',
      message: `Running UMAP layout... (epoch ${epoch}/${totalEpochs})`,
      completed: epoch,
      total: totalEpochs,
    });
    return normalized;
  }

  let coords;
  let normalized;
  if (combinedVectors.length <= 2) {
    coords = combinedVectors.map((_, idx) => [idx, idx]);
    normalized = emitLayoutSnapshot(coords, 1, 1);
  } else {
    const totalEpochs = 200;
    const sampleEpochs = buildEpochSampleSet(totalEpochs, 6);
    const umap = new UMAP({
      nComponents: 2,
      nNeighbors: 15,
      minDist: 0.1,
      nEpochs: totalEpochs,
      spread: 1.0,
    });
    coords = await umap.fitAsync(combinedVectors, (epochNumber) => {
      const epoch = epochNumber + 1;
      if (!sampleEpochs.has(epoch) && epoch < totalEpochs) return;
      const embedding = umap.getEmbedding();
      if (!Array.isArray(embedding) || embedding.length === 0) return;
      normalized = emitLayoutSnapshot(embedding, epoch, totalEpochs);
    });
  }
  console.log('[pipeline] UMAP complete', { points: coords.length });

  if (!normalized) {
    normalized = normalizeCoordinates(coords);
    onLayoutSnapshot?.(
      successfulImages.map((item, index) => ({
        id: item.id,
        x: normalized[index][0],
        y: normalized[index][1],
      }))
    );
  }
  const output = successfulImages.map((item, index) => {
    const workerData = byId.get(item.id);
    return {
      id: item.id,
      x: normalized[index][0],
      y: normalized[index][1],
      thumbUrl: item.thumbUrl,
      originalUrl: item.originalUrl,
      dominantColors: workerData.dominantColors,
      title: item.title,
      description: item.description,
      sourceUrl: item.sourceUrl,
      createdAt: item.createdAt,
    };
  });

  onProgress?.({
    stage: 'done',
    message: `Done: ${output.length} images clustered.`,
    completed: output.length,
    total: output.length,
  });

  console.log('[pipeline] Run complete', {
    output: output.length,
    runtimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
  return output;
}
