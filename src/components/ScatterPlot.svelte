<script>
  import { onDestroy, onMount } from 'svelte';

  export let points = [];
  export let viewportWidth = 1200;
  export let viewportHeight = 800;
  export let spriteSize = 24;
  export let isLoading = false;
  export let onHover = () => {};

  let canvasEl;
  let ctx;
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

  const MAX_CONCURRENT_IMAGE_LOADS = 6;
  const IMAGE_FADE_MS = 220;
  const POSITION_SMOOTHING = 14;
  const POSITION_SETTLE_EPSILON = 0.35;
  const LARGE_DATASET_POINT_THRESHOLD = 2000;
  const MAX_PERF_DPR = 1.25;

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

  function pumpImageQueue() {
    while (activeImageLoads < MAX_CONCURRENT_IMAGE_LOADS && loadQueue.length > 0) {
      const nextUrl = loadQueue.shift();
      const nextEntry = imageByUrl.get(nextUrl);
      if (!nextEntry || nextEntry.loaded || nextEntry.failed || nextEntry.loading) continue;
      nextEntry.queued = false;
      startImageRequest(nextUrl, nextEntry);
    }
  }

  function getOrQueueImage(url) {
    if (!url) return null;
    const existing = imageByUrl.get(url);
    const entry = existing || createImageEntry(url);
    if (!entry.loaded && !entry.failed && !entry.loading && !entry.queued) {
      entry.queued = true;
      loadQueue.push(url);
      pumpImageQueue();
    }
    return entry;
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
    ctx.scale(currentDpr, currentDpr);

    const half = spriteSize / 2;
    for (const sourcePoint of points) {
      if (!sourcePoint.revealed) continue;
      const motion = motionById.get(sourcePoint.id);
      if (!motion) continue;
      if (
        motion.x < -half ||
        motion.y < -half ||
        motion.x > viewportWidth + half ||
        motion.y > viewportHeight + half
      ) {
        continue;
      }
      const entry = getOrQueueImage(sourcePoint.thumbUrl);
      if (entry?.loaded) {
        const age = Math.max(0, nowMs - entry.loadedAt);
        const alpha = Math.min(1, age / IMAGE_FADE_MS);
        const drawWidth = entry.drawWidth || spriteSize;
        const drawHeight = entry.drawHeight || spriteSize;
        ctx.globalAlpha = alpha;
        ctx.drawImage(
          entry.img,
          motion.x - drawWidth / 2,
          motion.y - drawHeight / 2,
          drawWidth,
          drawHeight
        );
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = '#ccc';
        ctx.beginPath();
        ctx.arc(motion.x, motion.y, Math.max(3, spriteSize * 0.18), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  function hasActiveImageFades(nowMs = performance.now()) {
    for (const entry of imageByUrl.values()) {
      if (!entry.loaded) continue;
      if (nowMs - entry.loadedAt < IMAGE_FADE_MS) return true;
    }
    return false;
  }

  function frameStep(nowMs) {
    rafHandle = null;
    if (!frameRunning) return;
    const prevFrame = lastFrameAt ?? nowMs;
    const dtMs = Math.max(1, Math.min(33, nowMs - prevFrame));
    lastFrameAt = nowMs;

    const moving = updateMotion(dtMs);
    if (moving) refreshRenderedPoints();
    draw(nowMs);

    const keepRunning = moving || hasActiveImageFades(nowMs);
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
    const maxDistSq = (spriteSize / 2) ** 2;
    const searchRadius = Math.max(1, Math.ceil((spriteSize / 2) / cellSize) + 1);
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
    const rect = canvasEl.getBoundingClientRect();
    const scaleX = (canvasEl.width / currentDpr) / rect.width;
    const scaleY = (canvasEl.height / currentDpr) / rect.height;
    const px = (event.clientX - rect.left) * scaleX;
    const py = (event.clientY - rect.top) * scaleY;
    const id = findHoveredPointId(px, py);
    if (id === hoveredPointId) return;
    hoveredPointId = id;
    onHover(id ? (sourcePointById.get(id) ?? renderedPointById.get(id) ?? null) : null);
  }

  function clearHover() {
    if (hoveredPointId === null) return;
    hoveredPointId = null;
    onHover(null);
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
    currentDpr = getRenderDpr();
    canvasEl.width = viewportWidth * currentDpr;
    canvasEl.height = viewportHeight * currentDpr;
    startFrameLoop();
  }

  onMount(() => {
    ctx = canvasEl.getContext('2d');
    resizeCanvas();
    canvasEl.addEventListener('pointermove', handlePointerMove);
    canvasEl.addEventListener('pointerleave', clearHover);
  });

  onDestroy(() => {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    frameRunning = false;
    lastFrameAt = null;
    if (canvasEl) {
      canvasEl.removeEventListener('pointermove', handlePointerMove);
      canvasEl.removeEventListener('pointerleave', clearHover);
    }
    imageByUrl.clear();
    motionById.clear();
    loadQueue = [];
    activeImageLoads = 0;
  });

  $: if (canvasEl) {
    viewportWidth;
    viewportHeight;
    isLoading;
    points.length;
    resizeCanvas();
  }

  $: {
    points;
    spriteSize;
    refreshCachedSpriteSizes();
    syncMotionTargets();
    for (const point of points) {
      if (point.revealed) getOrQueueImage(point.thumbUrl);
    }
    startFrameLoop();
  }
</script>

<canvas
  bind:this={canvasEl}
  class="cluster-canvas"
  aria-label="Image plot"
></canvas>

<style>
  .cluster-canvas {
    width: 100%;
    height: 100%;
    display: block;
    position: relative;
    z-index: 0;
    cursor: default;
  }
</style>
