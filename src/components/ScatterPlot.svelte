<script>
  import { onDestroy, onMount } from 'svelte';

  export let points = [];
  export let viewportWidth = 1200;
  export let viewportHeight = 800;
  export let worldWidth = 1200;
  export let worldHeight = 800;
  export let spriteSize = 24;
  export let isLoading = false;
  export let onHover = () => {};

  let canvasEl;
  let ctx;
  let minimapEl;
  let minimapCtx;
  let imageByUrl = new Map();
  let sourcePointById = new Map();
  let renderedPointById = new Map();
  let pointIdsByCell = new Map();
  let motionById = new Map();
  let loadQueue = [];
  let activeImageLoads = 0;
  let hoveredPointId = null;
  let rafHandle = null;
  let frameRunning = false;
  let lastFrameAt = null;
  let currentDpr = 1;
  let cameraX = worldWidth / 2;
  let cameraY = worldHeight / 2;
  let zoom = 1;
  let isDragging = false;
  let isDraggingMinimap = false;
  let dragPointerId = null;
  let lastDragScreenX = 0;
  let lastDragScreenY = 0;
  let hasCameraInteraction = false;
  let firstPaintUntilMs = 0;
  let previousPointCount = 0;
  let hadLargeDataset = false;
  let minimapIntentWorldX = null;
  let minimapIntentWorldY = null;
  let minimapIntentActiveUntilMs = 0;

  const BASE_CONCURRENT_IMAGE_LOADS = 20;
  const LARGE_DATASET_MAX_CONCURRENT_IMAGE_LOADS = 32;
  const VERY_LARGE_DATASET_MAX_CONCURRENT_IMAGE_LOADS = 48;
  const MAX_IMAGE_ENQUEUES_PER_FRAME = 220;
  const FIRST_PAINT_MAX_IMAGE_ENQUEUES_PER_FRAME = 420;
  const FIRST_PAINT_DURATION_MS = 1800;
  const CAMERA_PRIORITY_PRELOAD_COUNT = 500;
  const FIRST_PAINT_PRIORITY_PRELOAD_COUNT = 900;
  const OUTER_RING_OVERSCAN_MULTIPLIER = 2.4;
  const OUTER_RING_PREFETCH_COUNT = 500;
  const MINIMAP_INTENT_PREFETCH_COUNT = 350;
  const MINIMAP_INTENT_HOLD_MS = 1600;
  const POSITION_SMOOTHING = 14;
  const POSITION_SETTLE_EPSILON = 0.35;
  const LARGE_DATASET_POINT_THRESHOLD = 2000;
  const MAX_PERF_DPR = 1.25;
  const CRITICAL_POINT_THRESHOLD = 2500;
  const VERY_LARGE_POINT_THRESHOLD = 4500;
  const MINIMAP_MAX_WIDTH = 220;
  const MINIMAP_MAX_HEIGHT = 160;
  const MINIMAP_MIN_SIZE = 120;
  // Prevent full zoom-out so oversized datasets cannot all fit onscreen at once.
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 6;
  const HIGH_RES_SOURCE_SWITCH_PX = 72;
  const EAGER_PRELOAD_HIGH_PRIORITY_COUNT = 700;
  let minimapWidth = 180;
  let minimapHeight = 120;
  let lastEagerQueuedPointCount = 0;

  function getContainedSpriteSize(img) {
    const width = img?.naturalWidth || img?.width || 1;
    const height = img?.naturalHeight || img?.height || 1;
    if (!width || !height) return { drawWidth: spriteSize, drawHeight: spriteSize };

    const scale = Math.min(spriteSize / width, spriteSize / height);
    return {
      drawWidth: width * scale,
      drawHeight: height * scale,
    };
  }

  function cellKey(cx, cy) {
    return `${cx},${cy}`;
  }

  function getCellSize() {
    return Math.max(24, spriteSize * 1.5);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getViewportPointFromEvent(event) {
    if (!canvasEl) return { x: 0, y: 0 };
    const rect = canvasEl.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * viewportWidth;
    const y = ((event.clientY - rect.top) / rect.height) * viewportHeight;
    return { x, y };
  }

  function getMinimapPointFromEvent(event) {
    if (!minimapEl) return { x: 0, y: 0 };
    const rect = minimapEl.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * minimapWidth;
    const y = ((event.clientY - rect.top) / rect.height) * minimapHeight;
    return { x, y };
  }

  function screenToWorld(screenX, screenY) {
    return {
      x: cameraX + (screenX - viewportWidth / 2) / zoom,
      y: cameraY + (screenY - viewportHeight / 2) / zoom,
    };
  }

  function updateCursor() {
    if (!canvasEl) return;
    canvasEl.style.cursor = isDragging ? 'grabbing' : 'grab';
  }

  function zoomAtScreenPoint(screenX, screenY, factor) {
    const before = screenToWorld(screenX, screenY);
    const nextZoom = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(nextZoom - zoom) < 1e-4) return;
    zoom = nextZoom;
    cameraX = before.x - (screenX - viewportWidth / 2) / zoom;
    cameraY = before.y - (screenY - viewportHeight / 2) / zoom;
    hasCameraInteraction = true;
    startFrameLoop();
  }

  function buildSpatialIndex(pts) {
    const cellSize = getCellSize();
    renderedPointById = new Map();
    pointIdsByCell = new Map();
    for (const point of pts) {
      renderedPointById.set(point.id, point);
      const cx = Math.floor(point.px / cellSize);
      const cy = Math.floor(point.py / cellSize);
      const key = cellKey(cx, cy);
      const cell = pointIdsByCell.get(key);
      if (cell) cell.push(point.id);
      else pointIdsByCell.set(key, [point.id]);
    }
  }

  function createImageEntry(url) {
    const entry = {
      img: new Image(),
      loaded: false,
      failed: false,
      loading: false,
      queued: false,
      loadedAt: 0,
      retryWithoutCors: true,
      drawWidth: spriteSize,
      drawHeight: spriteSize,
    };
    imageByUrl.set(url, entry);
    return entry;
  }

  function finishImageLoad(entry, success) {
    activeImageLoads = Math.max(0, activeImageLoads - 1);
    entry.loading = false;
    if (!success) entry.failed = true;
    pumpImageQueue();
    startFrameLoop();
  }

  function startImageRequest(url, entry) {
    if (!entry || entry.loaded || entry.failed || entry.loading) return;
    entry.loading = true;
    activeImageLoads += 1;
    entry.img.crossOrigin = 'anonymous';
    entry.img.onload = () => {
      entry.loaded = true;
      entry.failed = false;
      entry.loadedAt = performance.now();
      const size = getContainedSpriteSize(entry.img);
      entry.drawWidth = size.drawWidth;
      entry.drawHeight = size.drawHeight;
      finishImageLoad(entry, true);
    };
    entry.img.onerror = () => {
      if (entry.retryWithoutCors) {
        entry.retryWithoutCors = false;
        entry.img.crossOrigin = null;
        entry.img.onload = () => {
          entry.loaded = true;
          entry.failed = false;
          entry.loadedAt = performance.now();
          const size = getContainedSpriteSize(entry.img);
          entry.drawWidth = size.drawWidth;
          entry.drawHeight = size.drawHeight;
          finishImageLoad(entry, true);
        };
        entry.img.onerror = () => finishImageLoad(entry, false);
        entry.img.src = url;
        return;
      }
      finishImageLoad(entry, false);
    };
    entry.img.src = url;
  }

  function getMaxConcurrentImageLoads() {
    if (points.length >= VERY_LARGE_POINT_THRESHOLD) return VERY_LARGE_DATASET_MAX_CONCURRENT_IMAGE_LOADS;
    if (points.length >= LARGE_DATASET_POINT_THRESHOLD) return LARGE_DATASET_MAX_CONCURRENT_IMAGE_LOADS;
    return BASE_CONCURRENT_IMAGE_LOADS;
  }

  function shouldAllowHighResUpgrades() {
    return loadQueue.length === 0 && activeImageLoads === 0;
  }

  function pumpImageQueue() {
    while (activeImageLoads < getMaxConcurrentImageLoads() && loadQueue.length > 0) {
      const nextUrl = loadQueue.shift();
      const nextEntry = imageByUrl.get(nextUrl);
      if (!nextEntry || nextEntry.loaded || nextEntry.failed || nextEntry.loading) continue;
      nextEntry.queued = false;
      startImageRequest(nextUrl, nextEntry);
    }
  }

  function getOrQueueImage(url, { canQueue = true, priority = 'normal' } = {}) {
    if (!url) return null;
    const existing = imageByUrl.get(url);
    const entry = existing || createImageEntry(url);
    if (canQueue && !entry.loaded && !entry.failed && !entry.loading && !entry.queued) {
      entry.queued = true;
      if (priority === 'high') loadQueue.unshift(url);
      else loadQueue.push(url);
      pumpImageQueue();
    }
    return entry;
  }

  function requestImage(url, canQueue, priority = 'normal') {
    if (!url) return { entry: null, queuedNow: false };
    const existing = imageByUrl.get(url);
    const wasPending = existing ? existing.loading || existing.queued : false;
    const wasTerminal = existing ? existing.loaded || existing.failed : false;
    const entry = getOrQueueImage(url, { canQueue, priority });
    const queuedNow =
      canQueue &&
      !!entry &&
      !wasPending &&
      !wasTerminal &&
      !entry.loaded &&
      !entry.failed &&
      (entry.loading || entry.queued);
    return { entry, queuedNow };
  }

  function eagerQueueAllThumbs() {
    if (points.length === 0 || points.length === lastEagerQueuedPointCount) return;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (!point?.revealed) continue;
      const thumbUrl = point.thumbUrl || point.originalUrl;
      if (!thumbUrl) continue;
      requestImage(
        thumbUrl,
        true,
        index < EAGER_PRELOAD_HIGH_PRIORITY_COUNT ? 'high' : 'normal'
      );
    }
    lastEagerQueuedPointCount = points.length;
    startFrameLoop();
  }

  function sortVisibleIdsByCameraDistance(ids) {
    return [...ids].sort((a, b) => {
      const aMotion = motionById.get(a) ?? renderedPointById.get(a);
      const bMotion = motionById.get(b) ?? renderedPointById.get(b);
      if (!aMotion || !bMotion) return 0;
      const aDistSq = (aMotion.x - cameraX) ** 2 + (aMotion.y - cameraY) ** 2;
      const bDistSq = (bMotion.x - cameraX) ** 2 + (bMotion.y - cameraY) ** 2;
      return aDistSq - bDistSq;
    });
  }

  function sortIdsByDistanceToTarget(ids, targetX, targetY) {
    return [...ids].sort((a, b) => {
      const aMotion = motionById.get(a) ?? renderedPointById.get(a);
      const bMotion = motionById.get(b) ?? renderedPointById.get(b);
      if (!aMotion || !bMotion) return 0;
      const aDistSq = (aMotion.x - targetX) ** 2 + (aMotion.y - targetY) ** 2;
      const bDistSq = (bMotion.x - targetX) ** 2 + (bMotion.y - targetY) ** 2;
      return aDistSq - bDistSq;
    });
  }

  function shouldUseFirstPaintMode(nowMs) {
    return points.length >= CRITICAL_POINT_THRESHOLD && nowMs <= firstPaintUntilMs;
  }

  function prefetchThumbsForIds(ids, nowMs, enqueueBudget, priority = 'normal', limit = ids.length) {
    if (enqueueBudget <= 0 || !Array.isArray(ids) || ids.length === 0) return enqueueBudget;
    const capped = limit < ids.length ? ids.slice(0, limit) : ids;
    for (const id of capped) {
      if (enqueueBudget <= 0) break;
      const sourcePoint = sourcePointById.get(id) ?? renderedPointById.get(id);
      if (!sourcePoint?.revealed) continue;
      const thumbUrl = sourcePoint.thumbUrl || sourcePoint.originalUrl;
      if (!thumbUrl) continue;
      const req = requestImage(thumbUrl, enqueueBudget > 0, priority);
      if (req.queuedNow) enqueueBudget -= 1;
    }
    if (enqueueBudget < MAX_IMAGE_ENQUEUES_PER_FRAME && nowMs <= firstPaintUntilMs + 50) {
      startFrameLoop();
    }
    return enqueueBudget;
  }

  function getMinimapWorldPoint(point) {
    if (!worldWidth || !worldHeight) return null;
    const scale = Math.min(minimapWidth / Math.max(1, worldWidth), minimapHeight / Math.max(1, worldHeight));
    const contentWidth = worldWidth * scale;
    const contentHeight = worldHeight * scale;
    const offsetX = (minimapWidth - contentWidth) / 2;
    const offsetY = (minimapHeight - contentHeight) / 2;
    const worldX = (point.x - offsetX) / scale;
    const worldY = (point.y - offsetY) / scale;
    return {
      x: clamp(worldX, 0, worldWidth),
      y: clamp(worldY, 0, worldHeight),
    };
  }

  function setMinimapIntentFromEvent(event) {
    const point = getMinimapPointFromEvent(event);
    const worldPoint = getMinimapWorldPoint(point);
    if (!worldPoint) return;
    minimapIntentWorldX = worldPoint.x;
    minimapIntentWorldY = worldPoint.y;
    minimapIntentActiveUntilMs = performance.now() + MINIMAP_INTENT_HOLD_MS;
    startFrameLoop();
  }

  function refreshCachedSpriteSizes() {
    for (const entry of imageByUrl.values()) {
      if (!entry.loaded) continue;
      const size = getContainedSpriteSize(entry.img);
      entry.drawWidth = size.drawWidth;
      entry.drawHeight = size.drawHeight;
    }
  }

  function scheduleDrawFrame() {
    if (rafHandle) return;
    rafHandle = requestAnimationFrame(frameStep);
  }

  function refreshRenderedPoints() {
    const rendered = [];
    for (const source of points) {
      const motion = motionById.get(source.id);
      if (!motion) continue;
      rendered.push({
        ...source,
        px: motion.x,
        py: motion.y,
      });
    }
    buildSpatialIndex(rendered);
  }

  function syncMotionTargets() {
    sourcePointById = new Map(points.map((point) => [point.id, point]));
    const nextIds = new Set(points.map((point) => point.id));

    for (const point of points) {
      const existing = motionById.get(point.id);
      if (existing) {
        existing.targetX = point.px;
        existing.targetY = point.py;
      } else {
        motionById.set(point.id, {
          x: point.px,
          y: point.py,
          targetX: point.px,
          targetY: point.py,
        });
      }
    }

    for (const id of motionById.keys()) {
      if (!nextIds.has(id)) motionById.delete(id);
    }

    refreshRenderedPoints();
  }

  function updateMotion(dtMs) {
    const t = 1 - Math.exp((-dtMs / 1000) * POSITION_SMOOTHING);
    let moving = false;
    for (const motion of motionById.values()) {
      const dx = motion.targetX - motion.x;
      const dy = motion.targetY - motion.y;
      if (Math.abs(dx) > POSITION_SETTLE_EPSILON || Math.abs(dy) > POSITION_SETTLE_EPSILON) {
        motion.x += dx * t;
        motion.y += dy * t;
        moving = true;
      } else {
        motion.x = motion.targetX;
        motion.y = motion.targetY;
      }
    }
    return moving;
  }

  function draw(nowMs = performance.now()) {
    if (!ctx || !canvasEl) return;

    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.save();
    ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
    ctx.translate(viewportWidth / 2, viewportHeight / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-cameraX, -cameraY);

    const viewHalfW = viewportWidth / (2 * zoom);
    const viewHalfH = viewportHeight / (2 * zoom);
    const worldMinX = cameraX - viewHalfW - spriteSize;
    const worldMaxX = cameraX + viewHalfW + spriteSize;
    const worldMinY = cameraY - viewHalfH - spriteSize;
    const worldMaxY = cameraY + viewHalfH + spriteSize;
    const visibleIds = getVisiblePointIds(worldMinX, worldMaxX, worldMinY, worldMaxY);
    const prioritizedIds = sortVisibleIdsByCameraDistance(visibleIds);
    const firstPaintMode = shouldUseFirstPaintMode(nowMs);
    const shouldPreferHighRes =
      !firstPaintMode &&
      spriteSize * zoom >= HIGH_RES_SOURCE_SWITCH_PX &&
      shouldAllowHighResUpgrades();
    let enqueueBudget = firstPaintMode
      ? FIRST_PAINT_MAX_IMAGE_ENQUEUES_PER_FRAME
      : MAX_IMAGE_ENQUEUES_PER_FRAME;
    const viewportPriorityCount = firstPaintMode
      ? FIRST_PAINT_PRIORITY_PRELOAD_COUNT
      : CAMERA_PRIORITY_PRELOAD_COUNT;

    for (let index = 0; index < prioritizedIds.length; index += 1) {
      const id = prioritizedIds[index];
      const sourcePoint = sourcePointById.get(id) ?? renderedPointById.get(id);
      if (!sourcePoint?.revealed) continue;
      const motion = motionById.get(id);
      if (!motion) continue;
      const requestPriority = index < viewportPriorityCount ? 'high' : 'normal';

      const displayUrl = sourcePoint.thumbUrl || sourcePoint.originalUrl;
      const displayRequest = requestImage(displayUrl, enqueueBudget > 0, requestPriority);
      if (displayRequest.queuedNow) enqueueBudget -= 1;
      const displayEntry = displayRequest.entry;
      let entry = displayEntry;

      const shouldRequestHighRes =
        shouldPreferHighRes &&
        !!sourcePoint.originalUrl &&
        sourcePoint.originalUrl !== displayUrl;
      if (shouldRequestHighRes) {
        const highResRequest = requestImage(sourcePoint.originalUrl, enqueueBudget > 0, requestPriority);
        if (highResRequest.queuedNow) enqueueBudget -= 1;
        if (highResRequest.entry?.loaded) {
          entry = highResRequest.entry;
        }
      }

      if (entry?.loaded) {
        const drawWidth = entry.drawWidth || spriteSize;
        const drawHeight = entry.drawHeight || spriteSize;
        ctx.drawImage(
          entry.img,
          motion.x - drawWidth / 2,
          motion.y - drawHeight / 2,
          drawWidth,
          drawHeight
        );
      }
    }

    if (enqueueBudget > 0) {
      const ringOverscan = Math.max(spriteSize * OUTER_RING_OVERSCAN_MULTIPLIER, Math.min(viewHalfW, viewHalfH));
      const ringMinX = worldMinX - ringOverscan;
      const ringMaxX = worldMaxX + ringOverscan;
      const ringMinY = worldMinY - ringOverscan;
      const ringMaxY = worldMaxY + ringOverscan;
      const ringIds = getVisiblePointIds(ringMinX, ringMaxX, ringMinY, ringMaxY);
      const visibleSet = new Set(visibleIds);
      const outerRingIds = ringIds.filter((id) => !visibleSet.has(id));
      const prioritizedOuterRing = sortVisibleIdsByCameraDistance(outerRingIds);
      enqueueBudget = prefetchThumbsForIds(
        prioritizedOuterRing,
        nowMs,
        enqueueBudget,
        firstPaintMode ? 'high' : 'normal',
        OUTER_RING_PREFETCH_COUNT
      );
    }

    if (
      enqueueBudget > 0 &&
      minimapIntentWorldX != null &&
      minimapIntentWorldY != null &&
      nowMs <= minimapIntentActiveUntilMs
    ) {
      const intentHalfW = viewportWidth / (2 * zoom);
      const intentHalfH = viewportHeight / (2 * zoom);
      const intentOverscan = Math.max(spriteSize * 2, Math.min(intentHalfW, intentHalfH) * 0.35);
      const intentIds = getVisiblePointIds(
        minimapIntentWorldX - intentHalfW - intentOverscan,
        minimapIntentWorldX + intentHalfW + intentOverscan,
        minimapIntentWorldY - intentHalfH - intentOverscan,
        minimapIntentWorldY + intentHalfH + intentOverscan
      );
      const prioritizedIntentIds = sortIdsByDistanceToTarget(
        intentIds,
        minimapIntentWorldX,
        minimapIntentWorldY
      );
      prefetchThumbsForIds(
        prioritizedIntentIds,
        nowMs,
        enqueueBudget,
        'high',
        MINIMAP_INTENT_PREFETCH_COUNT
      );
    }

    ctx.restore();
    drawMinimap();
  }

  function resizeMinimap() {
    if (!minimapEl) return;
    const worldW = Math.max(1, worldWidth || 1);
    const worldH = Math.max(1, worldHeight || 1);
    const worldAspect = worldW / worldH;
    const maxAspect = MINIMAP_MAX_WIDTH / MINIMAP_MAX_HEIGHT;
    if (worldAspect >= maxAspect) {
      minimapWidth = MINIMAP_MAX_WIDTH;
      minimapHeight = Math.max(MINIMAP_MIN_SIZE, Math.round(minimapWidth / worldAspect));
    } else {
      minimapHeight = MINIMAP_MAX_HEIGHT;
      minimapWidth = Math.max(MINIMAP_MIN_SIZE, Math.round(minimapHeight * worldAspect));
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const nextWidth = Math.round(minimapWidth * dpr);
    const nextHeight = Math.round(minimapHeight * dpr);
    if (minimapEl.width !== nextWidth || minimapEl.height !== nextHeight) {
      minimapEl.width = nextWidth;
      minimapEl.height = nextHeight;
    }
  }

  function drawMinimap() {
    if (!minimapEl || !minimapCtx) return;
    const dpr = minimapEl.width / Math.max(1, minimapWidth) || 1;
    minimapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    minimapCtx.clearRect(0, 0, minimapWidth, minimapHeight);

    minimapCtx.fillStyle = 'rgba(18, 18, 22, 0.7)';
    minimapCtx.fillRect(0, 0, minimapWidth, minimapHeight);

    if (!worldWidth || !worldHeight) return;

    const scale = Math.min(minimapWidth / Math.max(1, worldWidth), minimapHeight / Math.max(1, worldHeight));
    const contentWidth = worldWidth * scale;
    const contentHeight = worldHeight * scale;
    const offsetX = (minimapWidth - contentWidth) / 2;
    const offsetY = (minimapHeight - contentHeight) / 2;

    minimapCtx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    minimapCtx.fillRect(offsetX, offsetY, contentWidth, contentHeight);

    minimapCtx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    for (const point of renderedPointById.values()) {
      if (!point?.revealed) continue;
      const sourcePoint = sourcePointById.get(point.id) ?? point;
      const entry =
        imageByUrl.get(sourcePoint.thumbUrl) ??
        (sourcePoint.originalUrl ? imageByUrl.get(sourcePoint.originalUrl) : null);
      const drawW = Math.max(1, (entry?.drawWidth || spriteSize) * scale);
      const drawH = Math.max(1, (entry?.drawHeight || spriteSize) * scale);
      const x = offsetX + point.px * scale - drawW / 2;
      const y = offsetY + point.py * scale - drawH / 2;
      minimapCtx.fillRect(x, y, drawW, drawH);
    }

    const cameraViewWidth = viewportWidth / zoom;
    const cameraViewHeight = viewportHeight / zoom;
    const cameraLeft = offsetX + (cameraX - cameraViewWidth / 2) * scale;
    const cameraTop = offsetY + (cameraY - cameraViewHeight / 2) * scale;
    const cameraWidth = cameraViewWidth * scale;
    const cameraHeight = cameraViewHeight * scale;

    minimapCtx.strokeStyle = '#76b9ff';
    minimapCtx.lineWidth = 2;
    minimapCtx.strokeRect(cameraLeft, cameraTop, cameraWidth, cameraHeight);

    minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(offsetX + 0.5, offsetY + 0.5, contentWidth - 1, contentHeight - 1);
  }

  function getVisiblePointIds(minX, maxX, minY, maxY) {
    const cellSize = getCellSize();
    const minCellX = Math.floor(minX / cellSize);
    const maxCellX = Math.floor(maxX / cellSize);
    const minCellY = Math.floor(minY / cellSize);
    const maxCellY = Math.floor(maxY / cellSize);
    const ids = [];
    for (let cx = minCellX; cx <= maxCellX; cx += 1) {
      for (let cy = minCellY; cy <= maxCellY; cy += 1) {
        const cellIds = pointIdsByCell.get(cellKey(cx, cy));
        if (!cellIds) continue;
        for (const id of cellIds) ids.push(id);
      }
    }
    return ids;
  }

  function getTargetFrameIntervalMs() {
    if (points.length >= VERY_LARGE_POINT_THRESHOLD) {
      return isLoading ? 100 : 50;
    }
    if (points.length >= CRITICAL_POINT_THRESHOLD) {
      return isLoading ? 66 : 40;
    }
    if (points.length >= LARGE_DATASET_POINT_THRESHOLD) {
      return isLoading ? 50 : 33;
    }
    return 16;
  }

  function frameStep(nowMs) {
    rafHandle = null;
    if (!frameRunning) return;

    if (lastFrameAt == null) {
      lastFrameAt = nowMs;
    }
    const prevFrame = lastFrameAt;
    const frameIntervalMs = getTargetFrameIntervalMs();
    if (nowMs - prevFrame < frameIntervalMs) {
      scheduleDrawFrame();
      return;
    }

    const dtMs = Math.max(1, Math.min(100, nowMs - prevFrame));
    lastFrameAt = nowMs;

    const moving = updateMotion(dtMs);
    if (moving) refreshRenderedPoints();
    draw(nowMs);

    const keepRunning = moving;
    if (keepRunning) {
      scheduleDrawFrame();
    } else {
      frameRunning = false;
      lastFrameAt = null;
    }
  }

  function startFrameLoop() {
    frameRunning = true;
    scheduleDrawFrame();
  }

  function findHoveredPointId(px, py) {
    const cellSize = getCellSize();
    const cx = Math.floor(px / cellSize);
    const cy = Math.floor(py / cellSize);
    const hoverRadius = Math.max(spriteSize / 2, 8 / zoom);
    const maxDistSq = hoverRadius ** 2;
    const searchRadius = Math.max(1, Math.ceil(hoverRadius / cellSize) + 1);
    let best = null;
    let bestDist = Infinity;
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        const ids = pointIdsByCell.get(cellKey(cx + dx, cy + dy));
        if (!ids) continue;
        for (const id of ids) {
          const p = renderedPointById.get(id);
          if (!p?.revealed) continue;
          const d = (px - p.px) ** 2 + (py - p.py) ** 2;
          if (d <= maxDistSq && d < bestDist) {
            bestDist = d;
            best = id;
          }
        }
      }
    }
    return best;
  }

  function handlePointerMove(event) {
    if (!canvasEl) return;
    const { x: screenX, y: screenY } = getViewportPointFromEvent(event);
    if (isDragging && dragPointerId === event.pointerId) {
      const dx = screenX - lastDragScreenX;
      const dy = screenY - lastDragScreenY;
      lastDragScreenX = screenX;
      lastDragScreenY = screenY;
      cameraX -= dx / zoom;
      cameraY -= dy / zoom;
      hasCameraInteraction = true;
      clearHover();
      startFrameLoop();
      return;
    }

    const world = screenToWorld(screenX, screenY);
    const id = findHoveredPointId(world.x, world.y);
    if (id === hoveredPointId) return;
    hoveredPointId = id;
    onHover(id ? (sourcePointById.get(id) ?? renderedPointById.get(id) ?? null) : null);
  }

  function handlePointerDown(event) {
    if (!canvasEl || event.button !== 0) return;
    const { x, y } = getViewportPointFromEvent(event);
    isDragging = true;
    dragPointerId = event.pointerId;
    lastDragScreenX = x;
    lastDragScreenY = y;
    canvasEl.setPointerCapture(event.pointerId);
    updateCursor();
  }

  function stopDragging(pointerId) {
    if (!isDragging) return;
    if (pointerId != null && dragPointerId != null && pointerId !== dragPointerId) return;
    isDragging = false;
    dragPointerId = null;
    updateCursor();
  }

  function handlePointerUp(event) {
    stopDragging(event.pointerId);
  }

  function handlePointerCancel(event) {
    stopDragging(event.pointerId);
  }

  function handleWheel(event) {
    if (!canvasEl) return;
    event.preventDefault();
    const { x, y } = getViewportPointFromEvent(event);
    const factor = Math.exp(-event.deltaY * 0.0012);
    zoomAtScreenPoint(x, y, factor);
  }

  function clearHover() {
    if (hoveredPointId === null) return;
    hoveredPointId = null;
    onHover(null);
  }

  function moveCameraFromMinimapEvent(event) {
    const point = getMinimapPointFromEvent(event);
    const worldPoint = getMinimapWorldPoint(point);
    if (!worldPoint) return;
    cameraX = worldPoint.x;
    cameraY = worldPoint.y;
    hasCameraInteraction = true;
    clearHover();
    startFrameLoop();
  }

  function handleMinimapPointerDown(event) {
    if (!minimapEl || event.button !== 0) return;
    isDraggingMinimap = true;
    minimapEl.setPointerCapture(event.pointerId);
    setMinimapIntentFromEvent(event);
    moveCameraFromMinimapEvent(event);
  }

  function handleMinimapPointerMove(event) {
    setMinimapIntentFromEvent(event);
    if (isDraggingMinimap) moveCameraFromMinimapEvent(event);
  }

  function handleMinimapPointerUp() {
    isDraggingMinimap = false;
  }

  function handleMinimapPointerLeave() {
    minimapIntentActiveUntilMs = 0;
  }

  function getRenderDpr() {
    const rawDpr = window.devicePixelRatio || 1;
    if (isLoading || points.length >= LARGE_DATASET_POINT_THRESHOLD) {
      return Math.min(rawDpr, MAX_PERF_DPR);
    }
    return rawDpr;
  }

  function resizeCanvas() {
    if (!canvasEl) return;
    const nextDpr = getRenderDpr();
    const nextWidth = Math.round(viewportWidth * nextDpr);
    const nextHeight = Math.round(viewportHeight * nextDpr);

    // Avoid clearing the backing buffer unless dimensions actually changed.
    const needsResize =
      canvasEl.width !== nextWidth || canvasEl.height !== nextHeight || currentDpr !== nextDpr;

    currentDpr = nextDpr;
    if (needsResize) {
      canvasEl.width = nextWidth;
      canvasEl.height = nextHeight;
    }
    startFrameLoop();
  }

  onMount(() => {
    ctx = canvasEl.getContext('2d');
    minimapCtx = minimapEl.getContext('2d');
    resizeCanvas();
    resizeMinimap();
    updateCursor();
    canvasEl.addEventListener('pointermove', handlePointerMove);
    canvasEl.addEventListener('pointerdown', handlePointerDown);
    canvasEl.addEventListener('pointerup', handlePointerUp);
    canvasEl.addEventListener('pointercancel', handlePointerCancel);
    canvasEl.addEventListener('pointerleave', clearHover);
    canvasEl.addEventListener('wheel', handleWheel, { passive: false });
    minimapEl.addEventListener('pointerdown', handleMinimapPointerDown);
    minimapEl.addEventListener('pointermove', handleMinimapPointerMove);
    minimapEl.addEventListener('pointerup', handleMinimapPointerUp);
    minimapEl.addEventListener('pointercancel', handleMinimapPointerUp);
    minimapEl.addEventListener('pointerleave', handleMinimapPointerLeave);
  });

  onDestroy(() => {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    frameRunning = false;
    lastFrameAt = null;
    if (canvasEl) {
      canvasEl.removeEventListener('pointermove', handlePointerMove);
      canvasEl.removeEventListener('pointerdown', handlePointerDown);
      canvasEl.removeEventListener('pointerup', handlePointerUp);
      canvasEl.removeEventListener('pointercancel', handlePointerCancel);
      canvasEl.removeEventListener('pointerleave', clearHover);
      canvasEl.removeEventListener('wheel', handleWheel);
    }
    if (minimapEl) {
      minimapEl.removeEventListener('pointerdown', handleMinimapPointerDown);
      minimapEl.removeEventListener('pointermove', handleMinimapPointerMove);
      minimapEl.removeEventListener('pointerup', handleMinimapPointerUp);
      minimapEl.removeEventListener('pointercancel', handleMinimapPointerUp);
      minimapEl.removeEventListener('pointerleave', handleMinimapPointerLeave);
    }
    imageByUrl.clear();
    motionById.clear();
    loadQueue = [];
    activeImageLoads = 0;
  });

  $: if (canvasEl) {
    viewportWidth;
    viewportHeight;
    worldWidth;
    worldHeight;
    isLoading;
    points.length;
    if (points.length === 0) {
      hasCameraInteraction = false;
    }
    if (!hasCameraInteraction) {
      cameraX = worldWidth / 2;
      cameraY = worldHeight / 2;
      zoom = MIN_ZOOM;
    }
    resizeCanvas();
    resizeMinimap();
  }

  $: {
    points;
    spriteSize;
    if (points.length === 0) {
      firstPaintUntilMs = 0;
      previousPointCount = 0;
      hadLargeDataset = false;
      minimapIntentActiveUntilMs = 0;
      lastEagerQueuedPointCount = 0;
    } else {
      const isLargeDataset = points.length >= CRITICAL_POINT_THRESHOLD;
      if (previousPointCount === 0 || (!hadLargeDataset && isLargeDataset)) {
        firstPaintUntilMs = performance.now() + FIRST_PAINT_DURATION_MS;
      }
      previousPointCount = points.length;
      hadLargeDataset = isLargeDataset;
    }
    eagerQueueAllThumbs();
    refreshCachedSpriteSizes();
    syncMotionTargets();
    startFrameLoop();
  }
</script>

<div class="scatterplot-root">
  <canvas
    bind:this={canvasEl}
    class="cluster-canvas"
    aria-label="Image plot"
  ></canvas>
  <canvas
    bind:this={minimapEl}
    class="minimap-canvas"
    aria-label="Mini map"
    style={`width: ${minimapWidth}px; height: ${minimapHeight}px;`}
  ></canvas>
</div>

<style>
  .scatterplot-root {
    width: 100%;
    height: 100%;
    position: relative;
  }

  .cluster-canvas {
    width: 100%;
    height: 100%;
    display: block;
    position: relative;
    z-index: 0;
    cursor: default;
  }

  .minimap-canvas {
    position: absolute;
    bottom: 16px;
    left: 16px;
    z-index: 2;
    pointer-events: auto;
    cursor: pointer;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  }
</style>
