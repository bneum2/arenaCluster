<script>
  import { onMount } from 'svelte';
  import { parseArenaSlug, runArenaImagePipeline } from './src/lib/pipeline.js';
  import EntryScreen from './src/components/EntryScreen.svelte';
  import LoadingOverlay from './src/components/LoadingOverlay.svelte';
  import ErrorView from './src/components/ErrorView.svelte';
  import ScatterPlot from './src/components/ScatterPlot.svelte';
  import HoverCard from './src/components/HoverCard.svelte';

  const SUGGESTED_CHANNELS = ['kit-madness', 'best-textures', 'idk-n-yi8fdktls'];

  let loading = false;
  let error = '';
  let channelInput = '';
  let channelSlug = null;
  let hoveredBlock = null;
  let positionedImages = [];

  let viewportWidth = 1200;
  let viewportHeight = 800;

  let pipelineProgress = {
    stage: 'idle',
    message: '',
    completed: 0,
    total: 0,
    etaSeconds: null,
    modelLoading: false,
  };

  let currentRunId = 0;
  let currentAbortController = null;
  let runStartedAt = 0;
  let elapsedTick = Date.now();
  let elapsedTimerHandle = null;
  let revealFlushHandle = null;
  let pendingRevealIds = new Set();
  let staggerCounter = 0;
  const BASE_IMAGE_PADDING = 2;
  const PLOT_MARGIN_RATIO = 0.1;
  const LOADING_OVERSCAN_SCALE = 1.08;
  const FETCH_SPAWN_OVERSCAN_RATIO = 0.14;

  $: progressRatio = pipelineProgress.total
    ? Math.max(0, Math.min(1, pipelineProgress.completed / pipelineProgress.total))
    : 0;
  $: progressPercent = Math.round(progressRatio * 100);
  $: elapsedSeconds = runStartedAt ? Math.max(0, Math.floor((elapsedTick - runStartedAt) / 1000)) : 0;
  function startElapsedTimer() {
    if (elapsedTimerHandle) clearInterval(elapsedTimerHandle);
    elapsedTimerHandle = setInterval(() => {
      elapsedTick = Date.now();
    }, 1000);
  }

  function stopElapsedTimer() {
    if (!elapsedTimerHandle) return;
    clearInterval(elapsedTimerHandle);
    elapsedTimerHandle = null;
  }
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function computeSpriteSize(count, width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 24;
    const safeCount = Math.max(1, count);
    const sizeFromDensity = Math.sqrt((width * height) / safeCount) * 0.4;
    return Math.round(clamp(sizeFromDensity, 10, 56));
  }

  function toPixelPoint(item, width, height, useClusterMargin = true) {
    if (!useClusterMargin) {
      return {
        id: item.id,
        px: item.x * width,
        py: item.y * height,
      };
    }
    return {
      id: item.id,
      px: item.x * width * 0.8 + width * PLOT_MARGIN_RATIO,
      py: item.y * height * 0.8 + height * PLOT_MARGIN_RATIO,
    };
  }

  function buildCollisionFreeMap(items, width, height, spriteSize) {
    if (!Array.isArray(items) || items.length === 0) return new Map();
    const imagePadding = Math.max(BASE_IMAGE_PADDING, spriteSize * 0.08);
    const diameter = spriteSize + imagePadding;
    const radius = diameter / 2;
    const minDistanceSq = diameter * diameter;
    const gridSize = diameter;
    const cols = Math.max(1, Math.ceil(width / gridSize));
    const rows = Math.max(1, Math.ceil(height / gridSize));
    const minX = radius;
    const maxX = Math.max(radius, width - radius);
    const minY = radius;
    const maxY = Math.max(radius, height - radius);
    const grid = new Map();
    const placed = [];

    function keyFor(x, y) {
      const cx = clamp(Math.floor(x / gridSize), 0, cols - 1);
      const cy = clamp(Math.floor(y / gridSize), 0, rows - 1);
      return `${cx},${cy}`;
    }

    function addPlaced(index, x, y) {
      const key = keyFor(x, y);
      const cell = grid.get(key);
      if (cell) cell.push(index);
      else grid.set(key, [index]);
    }

    function canPlace(x, y) {
      const cellX = clamp(Math.floor(x / gridSize), 0, cols - 1);
      const cellY = clamp(Math.floor(y / gridSize), 0, rows - 1);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const nx = cellX + dx;
          const ny = cellY + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ids = grid.get(`${nx},${ny}`);
          if (!ids) continue;
          for (const id of ids) {
            const p = placed[id];
            const distSq = (x - p.px) ** 2 + (y - p.py) ** 2;
            if (distSq < minDistanceSq) return false;
          }
        }
      }
      return true;
    }

    // Stable hash so search direction remains deterministic by id.
    function hashId(id) {
      let hash = 2166136261;
      const str = String(id);
      for (let i = 0; i < str.length; i += 1) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return Math.abs(hash >>> 0);
    }

    for (const item of items) {
      const base = toPixelPoint(item, width, height);
      const centerX = clamp(base.px, minX, maxX);
      const centerY = clamp(base.py, minY, maxY);

      if (canPlace(centerX, centerY)) {
        placed.push({ id: item.id, px: centerX, py: centerY });
        addPlaced(placed.length - 1, centerX, centerY);
        continue;
      }

      let found = null;
      const maxRings = 36;
      const baseAngle = (hashId(item.id) % 360) * (Math.PI / 180);

      for (let ring = 1; ring <= maxRings && !found; ring += 1) {
        const steps = Math.max(10, ring * 10);
        const ringRadius = ring * (diameter * 0.45);
        for (let step = 0; step < steps; step += 1) {
          const angle = baseAngle + (step / steps) * Math.PI * 2;
          const candidateX = clamp(centerX + Math.cos(angle) * ringRadius, minX, maxX);
          const candidateY = clamp(centerY + Math.sin(angle) * ringRadius, minY, maxY);
          if (!canPlace(candidateX, candidateY)) continue;
          found = { px: candidateX, py: candidateY };
          break;
        }
      }

      const finalX = found ? found.px : centerX;
      const finalY = found ? found.py : centerY;
      placed.push({ id: item.id, px: finalX, py: finalY });
      addPlaced(placed.length - 1, finalX, finalY);
    }

    return new Map(placed.map((point) => [point.id, point]));
  }

  $: plotScale = loading ? LOADING_OVERSCAN_SCALE : 1;
  $: plotWidth = Math.round(viewportWidth * plotScale);
  $: plotHeight = Math.round(viewportHeight * plotScale);
  $: spriteSize = computeSpriteSize(positionedImages.length, plotWidth, plotHeight);
  $: shouldResolveCollisions = !loading && positionedImages.length > 0;
  $: collisionFreePixels = shouldResolveCollisions
    ? buildCollisionFreeMap(positionedImages, plotWidth, plotHeight, spriteSize)
    : new Map();
  $: imagePoints = positionedImages.map((item) => {
    const point =
      collisionFreePixels.get(item.id) || toPixelPoint(item, plotWidth, plotHeight, !loading);
    return {
      ...item,
      px: point.px,
      py: point.py,
    };
  });

  function randomCoord(overscanRatio = 0) {
    return -overscanRatio + Math.random() * (1 + overscanRatio * 2);
  }

  function flushReveals(runId) {
    revealFlushHandle = null;
    if (runId !== currentRunId || pendingRevealIds.size === 0) {
      pendingRevealIds.clear();
      return;
    }

    const revealIds = pendingRevealIds;
    pendingRevealIds = new Set();
    positionedImages = positionedImages.map((item) =>
      revealIds.has(item.id) ? { ...item, revealed: true } : item
    );
  }

  function revealImageLater(runId, id, delayMs) {
    setTimeout(() => {
      if (runId !== currentRunId) return;
      pendingRevealIds.add(id);
      if (revealFlushHandle) return;
      revealFlushHandle = setTimeout(() => flushReveals(runId), 70);
    }, delayMs);
  }

  function appendFetchedImages(runId, batch) {
    if (runId !== currentRunId || !Array.isArray(batch) || batch.length === 0) return;
    const existingIds = new Set(positionedImages.map((item) => item.id));
    const next = [];

    for (const item of batch) {
      if (existingIds.has(item.id)) continue;
      const revealDelayMs = Math.min(1800, staggerCounter * 45);
      staggerCounter += 1;
      next.push({
        id: item.id,
        thumbUrl: item.thumbUrl,
        originalUrl: item.originalUrl,
        title: item.title,
        description: item.description,
        sourceUrl: item.sourceUrl,
        createdAt: item.createdAt,
        dominantColors: [],
        x: randomCoord(FETCH_SPAWN_OVERSCAN_RATIO),
        y: randomCoord(FETCH_SPAWN_OVERSCAN_RATIO),
        revealDelayMs,
        revealed: false,
      });
      revealImageLater(runId, item.id, revealDelayMs);
    }

    if (next.length > 0) {
      positionedImages = [...positionedImages, ...next];
    }
  }

  function applyLayoutSnapshot(runId, snapshot) {
    if (runId !== currentRunId || !Array.isArray(snapshot) || snapshot.length === 0) return;
    const byId = new Map(snapshot.map((item) => [item.id, item]));
    positionedImages = positionedImages.map((item) => {
      const updated = byId.get(item.id);
      if (!updated) return item;
      return {
        ...item,
        x: Number.isFinite(updated.x) ? updated.x : item.x,
        y: Number.isFinite(updated.y) ? updated.y : item.y,
      };
    });
  }

  function useSuggestion(slug) {
    channelInput = slug;
    startClusterRun();
  }

  function formatEta(seconds) {
    if (seconds == null) return 'Estimating...';
    if (seconds < 60) return `~${seconds}s remaining`;
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `~${min}m ${sec}s remaining`;
  }

  function beginRun(slug) {
    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    currentRunId += 1;
    runStartedAt = Date.now();
    elapsedTick = runStartedAt;
    startElapsedTimer();
    channelSlug = slug;
    hoveredBlock = null;
    positionedImages = [];
    pendingRevealIds.clear();
    if (revealFlushHandle) {
      clearTimeout(revealFlushHandle);
      revealFlushHandle = null;
    }
    error = '';
    loading = true;
    staggerCounter = 0;
    pipelineProgress = {
      stage: 'fetch',
      message: 'Fetching channel blocks...',
      completed: 0,
      total: 0,
      etaSeconds: null,
      modelLoading: false,
    };
  }

  async function startClusterRun() {
    const slug = parseArenaSlug(channelInput);
    if (!slug) {
      error = 'Please enter a valid Are.na channel URL or slug.';
      return;
    }

    beginRun(slug);
    const runId = currentRunId;
    console.log('[app] Starting pipeline run', { slug, runId });

    try {
      const output = await runArenaImagePipeline({
        slug,
        workerCount: 4,
        batchSize: 8,
        signal: currentAbortController.signal,
        onImageBatch: (batch) => appendFetchedImages(runId, batch),
        onLayoutSnapshot: (snapshot) => applyLayoutSnapshot(runId, snapshot),
        onProgress: (progress) => {
          if (runId !== currentRunId) return;
          pipelineProgress = { ...pipelineProgress, ...progress };
          console.log('[app] Progress update', {
            stage: progress.stage,
            completed: progress.completed ?? null,
            total: progress.total ?? null,
            message: progress.message,
            etaSeconds: progress.etaSeconds ?? null,
            modelLoading: progress.modelLoading ?? false,
          });
        },
      });

      if (runId !== currentRunId) return;

      const outputById = new Map(output.map((item) => [item.id, item]));
      positionedImages = positionedImages
        .filter((item) => outputById.has(item.id))
        .map((item) => {
          const finalItem = outputById.get(item.id);
          return {
            ...item,
            ...finalItem,
            x: Number.isFinite(finalItem.x) ? finalItem.x : item.x,
            y: Number.isFinite(finalItem.y) ? finalItem.y : item.y,
            revealed: true,
          };
        });

      console.log('[app] Pipeline completed', {
        runId,
        points: positionedImages.length,
        runtimeSeconds: Math.round((Date.now() - runStartedAt) / 1000),
      });
    } catch (err) {
      if (runId !== currentRunId) return;
      if (currentAbortController?.signal.aborted) {
        console.log('[app] Run cancelled', { runId });
        return;
      }
      error = err instanceof Error ? err.message : String(err);
      console.error('[app] Pipeline failed', err);
    } finally {
      if (runId === currentRunId) {
        loading = false;
        stopElapsedTimer();
        elapsedTick = Date.now();
      }
    }
  }

  function resetToEntry() {
    error = '';
    channelSlug = null;
    hoveredBlock = null;
  }

  onMount(() => {
    const handleResize = () => {
      viewportWidth = window.innerWidth;
      viewportHeight = window.innerHeight;
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (currentAbortController) currentAbortController.abort();
      if (revealFlushHandle) clearTimeout(revealFlushHandle);
      pendingRevealIds.clear();
      stopElapsedTimer();
    };
  });
</script>

<main>
  {#if channelSlug === null}
    <EntryScreen
      bind:channelInput
      suggestedChannels={SUGGESTED_CHANNELS}
      onSubmit={startClusterRun}
      onSuggestion={useSuggestion}
    />
  {:else if error}
    <ErrorView error={error} onReset={resetToEntry} />
  {:else}
    <ScatterPlot
      points={imagePoints}
      viewportWidth={plotWidth}
      viewportHeight={plotHeight}
      {spriteSize}
      isLoading={loading}
      onHover={(point) => (hoveredBlock = point)}
    />
    {#if loading}
      <LoadingOverlay
        pipelineProgress={pipelineProgress}
        progressPercent={progressPercent}
        elapsedSeconds={elapsedSeconds}
        etaText={formatEta(pipelineProgress.etaSeconds)}
      />
    {/if}
  {/if}

  <HoverCard block={hoveredBlock} />
</main>

<style>
  :global(html), :global(body) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  main {
    width: 100vw;
    height: 100vh;
    background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    position: relative;
  }
</style>
