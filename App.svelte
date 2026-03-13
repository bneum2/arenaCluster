<script>
  import { onMount } from 'svelte';
  import { parseArenaSlug, preloadClipModel, runArenaImagePipeline } from './src/lib/pipeline.js';
  import EntryScreen from './src/components/EntryScreen.svelte';
  import LoadingOverlay from './src/components/LoadingOverlay.svelte';
  import ErrorView from './src/components/ErrorView.svelte';
  import ScatterPlot from './src/components/ScatterPlot.svelte';
  import CornerCircle from './src/components/CornerCircle.svelte';

  const SUGGESTED_CHANNELS = ['kit-madness', 'best-textures', 'idk-n-yi8fdktls'];

  let loading = false;
  let error = '';
  let channelInput = '';
  let channelSlug = null;
  let hoveredBlock = null;
  /** One slot per corner: [top-left, top-right, bottom-right]. Bottom-left = minimap. */
  let selectedBlocks = [null, null, null];
  let positionedImages = [];
  /** 'scatter' = current free layout; 'cluster' = grouped in rotating circles */
  let viewMode = 'scatter';

  let viewportWidth = 1200;
  let viewportHeight = 800;

  let pipelineProgress = {
    stage: 'idle',
    message: '',
    completed: 0,
    total: 0,
    etaSeconds: null,
    modelLoading: false,
    modelDownloadLoaded: null,
    modelDownloadTotal: null,
    modelDownloadPercent: null,
    modelDownloadStatus: null,
    modelDownloadFile: null,
  };
  let clipPreloadProgress = {
    active: false,
    message: '',
    loaded: null,
    total: null,
    percent: null,
    status: null,
    file: null,
    ready: false,
  };

  let currentRunId = 0;
  let currentAbortController = null;
  let runStartedAt = 0;
  let elapsedTick = Date.now();
  let elapsedTimerHandle = null;
  const BASE_IMAGE_PADDING = 2;
  const PLOT_MARGIN_RATIO = 0.1;
  const LOADING_OVERSCAN_SCALE = 1.08;
  const FETCH_SPAWN_OVERSCAN_RATIO = 0.14;
  const FULL_RENDER_POINT_THRESHOLD = 2500;
  const TARGET_MAX_VISIBLE_POINTS_LARGE = 500;

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

  $: datasetScale =
    positionedImages.length <= FULL_RENDER_POINT_THRESHOLD
      ? 1
      : Math.max(
          1,
          Math.sqrt(Math.max(1, positionedImages.length) / TARGET_MAX_VISIBLE_POINTS_LARGE)
        );
  $: plotScale = Math.max(loading ? LOADING_OVERSCAN_SCALE : 1, datasetScale);
  $: plotWidth = Math.round(viewportWidth * plotScale);
  $: plotHeight = Math.round(viewportHeight * plotScale);
  $: spriteSizingCount =
    loading && pipelineProgress.stage === 'fetch' && Number.isFinite(pipelineProgress.total)
      ? Math.max(positionedImages.length, pipelineProgress.total)
      : positionedImages.length;
  $: spriteSize = computeSpriteSize(spriteSizingCount, plotWidth, plotHeight);
  $: shouldResolveCollisions = !loading && positionedImages.length > 0 && viewMode === 'scatter';
  $: collisionFreePixels = shouldResolveCollisions
    ? buildCollisionFreeMap(positionedImages, plotWidth, plotHeight, spriteSize)
    : new Map();

  // K-means for cluster view: 2D on (x, y)
  function simpleKMeans2D(items, k, maxIterations = 50) {
    if (!items.length || k < 1) return { clusters: [], centroids: [] };
    const n = items.length;
    const data = items.map((item) => [item.x, item.y]);
    let centroids = [];
    for (let i = 0; i < k; i++) {
      const idx = Math.floor(Math.random() * n);
      centroids.push([data[idx][0], data[idx][1]]);
    }
    let clusters = new Array(n).fill(0);
    for (let iter = 0; iter < maxIterations; iter++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        let best = 0;
        let bestD = Infinity;
        for (let j = 0; j < k; j++) {
          const dx = data[i][0] - centroids[j][0];
          const dy = data[i][1] - centroids[j][1];
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
        if (clusters[i] !== best) {
          clusters[i] = best;
          changed = true;
        }
      }
      if (!changed) break;
      const sums = Array.from({ length: k }, () => [0, 0, 0]);
      for (let i = 0; i < n; i++) {
        const c = clusters[i];
        sums[c][0] += data[i][0];
        sums[c][1] += data[i][1];
        sums[c][2] += 1;
      }
      for (let j = 0; j < k; j++) {
        const count = sums[j][2] || 1;
        centroids[j] = [sums[j][0] / count, sums[j][1] / count];
      }
    }
    return { clusters, centroids };
  }

  const CLUSTER_RING_RADIUS = 155;
  const CLUSTER_CENTER_SPREAD = 1.4;
  const CLUSTER_MIN_COUNT = 3;
  const CLUSTER_MAX_COUNT = 12;

  $: clusterLayout =
    viewMode === 'cluster' && positionedImages.length >= CLUSTER_MIN_COUNT
      ? (() => {
          const k = Math.min(
            CLUSTER_MAX_COUNT,
            Math.max(2, Math.floor(Math.sqrt(positionedImages.length / 2)))
          );
          const { clusters, centroids } = simpleKMeans2D(positionedImages, k);
          const byCluster = new Map();
          for (let i = 0; i < positionedImages.length; i++) {
            const c = clusters[i];
            if (!byCluster.has(c)) byCluster.set(c, []);
            byCluster.get(c).push({ index: i, item: positionedImages[i] });
          }
          // Initial centers: near centroids are pushed outward, far ones stay compact.
          const centers = centroids.map(([cx, cy], idx) => {
            let nearest = Infinity;
            for (let j = 0; j < centroids.length; j++) {
              if (j === idx) continue;
              const [nx, ny] = centroids[j];
              const dx = cx - nx;
              const dy = cy - ny;
              const d = Math.hypot(dx, dy);
              if (d < nearest) nearest = d;
            }
            const NEAR_THRESHOLD = 0.25; // normalized distance; below this = \"too close\"
            const isNear = Number.isFinite(nearest) && nearest < NEAR_THRESHOLD;
            if (isNear) {
              return {
                x: (cx - 0.5) * plotWidth * CLUSTER_CENTER_SPREAD + plotWidth * 0.5,
                y: (cy - 0.5) * plotHeight * CLUSTER_CENTER_SPREAD + plotHeight * 0.5,
              };
            }
            return {
              x: cx * plotWidth * 0.8 + plotWidth * PLOT_MARGIN_RATIO,
              y: cy * plotHeight * 0.8 + plotHeight * PLOT_MARGIN_RATIO,
            };
          });

          // Resolve any remaining overlaps between cluster circles by gently
          // pushing overlapping centers apart. Far-apart clusters barely move.
          const MIN_CENTER_DISTANCE = CLUSTER_RING_RADIUS * 2 + 40; // diameter + margin
          const MAX_RELAX_ITERATIONS = 18;
          for (let iter = 0; iter < MAX_RELAX_ITERATIONS; iter++) {
            let anyOverlap = false;
            for (let i = 0; i < centers.length; i++) {
              for (let j = i + 1; j < centers.length; j++) {
                const a = centers[i];
                const b = centers[j];
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let dist = Math.hypot(dx, dy) || 1;
                if (dist >= MIN_CENTER_DISTANCE) continue;
                anyOverlap = true;
                const overlap = MIN_CENTER_DISTANCE - dist;
                const push = overlap / 2;
                dx /= dist;
                dy /= dist;
                // Push each center half the needed distance in opposite directions
                a.x -= dx * push;
                a.y -= dy * push;
                b.x += dx * push;
                b.y += dy * push;
              }
            }
            if (!anyOverlap) break;
          }
          const pointsWithAngle = [];
          for (let c = 0; c < centers.length; c++) {
            const members = byCluster.get(c) || [];
            members.forEach(({ item }, idx) => {
              const angle = (idx / members.length) * Math.PI * 2;
              pointsWithAngle.push({
                ...item,
                clusterId: c,
                angleInCluster: angle,
                px: centers[c].x,
                py: centers[c].y,
              });
            });
          }
          return { centers, pointsWithAngle };
        })()
      : null;

  $: imagePoints =
    viewMode === 'cluster' && clusterLayout
      ? clusterLayout.pointsWithAngle
      : positionedImages.map((item) => {
          const point =
            collisionFreePixels.get(item.id) || toPixelPoint(item, plotWidth, plotHeight, !loading);
          return {
            ...item,
            px: point.px,
            py: point.py,
          };
        });

  $: clusterCenters = clusterLayout ? clusterLayout.centers : [];
  $: ringRadius = CLUSTER_RING_RADIUS;

  function randomCoord(overscanRatio = 0) {
    return -overscanRatio + Math.random() * (1 + overscanRatio * 2);
  }

  function appendFetchedImages(runId, batch) {
    if (runId !== currentRunId || !Array.isArray(batch) || batch.length === 0) return;
    const existingIds = new Set(positionedImages.map((item) => item.id));
    const next = [];

    for (const item of batch) {
      if (existingIds.has(item.id)) continue;
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
        revealed: true,
      });
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
    error = '';
    loading = true;
    pipelineProgress = {
      stage: 'fetch',
      message: 'Fetching channel blocks...',
      completed: 0,
      total: 0,
      etaSeconds: null,
      modelLoading: false,
      modelDownloadLoaded: null,
      modelDownloadTotal: null,
      modelDownloadPercent: null,
      modelDownloadStatus: null,
      modelDownloadFile: null,
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
    selectedBlocks = [null, null, null];
  }

  function isBlockSelected(block) {
    return block && selectedBlocks.some((b) => b && b.id === block.id);
  }

  function handleBlockClick(block) {
    const idx = selectedBlocks.findIndex((b) => b && b.id === block.id);
    if (idx >= 0) {
      selectedBlocks[idx] = null;
      selectedBlocks = selectedBlocks;
      return;
    }
    let slot = selectedBlocks.findIndex((b) => !b);
    if (slot < 0) slot = 0;
    selectedBlocks[slot] = block;
    selectedBlocks = selectedBlocks;
  }

  function clearSlot(slotIndex) {
    selectedBlocks[slotIndex] = null;
    selectedBlocks = selectedBlocks;
  }

  onMount(() => {
    const handleResize = () => {
      viewportWidth = window.innerWidth;
      viewportHeight = window.innerHeight;
    };
    handleResize();
    window.addEventListener('resize', handleResize);

    preloadClipModel({
      onProgress: (progress) => {
        const active = progress?.stage === 'model_download' || progress?.modelLoading;
        clipPreloadProgress = {
          active: Boolean(active),
          message: progress?.message || '',
          loaded:
            typeof progress?.modelDownloadLoaded === 'number' ? progress.modelDownloadLoaded : null,
          total: typeof progress?.modelDownloadTotal === 'number' ? progress.modelDownloadTotal : null,
          percent:
            typeof progress?.modelDownloadPercent === 'number'
              ? progress.modelDownloadPercent
              : progress?.stage === 'model_ready'
                ? 100
                : null,
          status: typeof progress?.modelDownloadStatus === 'string' ? progress.modelDownloadStatus : null,
          file: typeof progress?.modelDownloadFile === 'string' ? progress.modelDownloadFile : null,
          ready: progress?.stage === 'model_ready',
        };
      },
    }).catch((err) => {
      console.warn('[app] CLIP warmup failed', err);
      clipPreloadProgress = {
        active: false,
        message: '',
        loaded: null,
        total: null,
        percent: null,
        status: null,
        file: null,
        ready: false,
      };
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      if (currentAbortController) currentAbortController.abort();
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
    <div class="view-mode-toggle">
      <button
        type="button"
        class="view-mode-btn"
        class:active={viewMode === 'scatter'}
        on:click={() => (viewMode = 'scatter')}
      >Scatter</button>
      <button
        type="button"
        class="view-mode-btn"
        class:active={viewMode === 'cluster'}
        on:click={() => (viewMode = 'cluster')}
      >Cluster</button>
    </div>
    <div class="canvas-clip">
      <ScatterPlot
        points={imagePoints}
        {viewportWidth}
        {viewportHeight}
        worldWidth={plotWidth}
        worldHeight={plotHeight}
        {spriteSize}
        isLoading={loading}
        viewMode={viewMode}
        clusterCenters={clusterCenters}
        {ringRadius}
        onHover={(point) => (hoveredBlock = point)}
        onBlockClick={handleBlockClick}
      />
    </div>
    <!-- Corner circles: top-left, top-right, bottom-right. Each can show one selected block. Bottom-left = minimap. -->
    {#each [0, 1, 2] as slotIndex}
      {@const block = selectedBlocks[slotIndex]}
      {@const corners = ['top-left', 'top-right', 'bottom-right']}
      <CornerCircle
        corner={corners[slotIndex]}
        expanded={block != null}
        onToggle={() => clearSlot(slotIndex)}
        label={block ? 'Collapse detail' : 'Click a point to show here'}
      >
        {#if block}
          <div class="detail-panel-inner">
            {#if block.thumbUrl}
              <a href="https://www.are.na/block/{block.id}" target="_blank" rel="noopener noreferrer" class="detail-image-wrap">
                <img src={block.thumbUrl} alt={block.title || 'Block'} class="detail-image" />
              </a>
            {/if}
            <div class="detail-panel-footer">
              <h3>{block.title || 'Untitled'}</h3>
              <button type="button" class="close-btn" on:click={(e) => { e.stopPropagation(); clearSlot(slotIndex); }}>×</button>
            </div>
          </div>
        {:else}
          <div class="detail-panel-inner">
            <p class="detail-placeholder">Click a point on the map to show it here.</p>
          </div>
        {/if}
      </CornerCircle>
    {/each}
    {#if loading}
      <LoadingOverlay
        pipelineProgress={pipelineProgress}
        clipPreloadProgress={clipPreloadProgress}
        progressPercent={progressPercent}
        elapsedSeconds={elapsedSeconds}
        etaText={formatEta(pipelineProgress.etaSeconds)}
      />
    {/if}
  {/if}
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

  .view-mode-toggle {
    position: absolute;
    top: 4%;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1002;
    display: flex;
    gap: 0.25rem;
  }

  .view-mode-btn {
    padding: 0.35rem 0.75rem;
    font-size: 0.85rem;
    border: 2px solid #d9d9d9;
    border-radius: 8px;
    background: #fff;
    color: #666;
    cursor: pointer;
  }

  .view-mode-btn:hover {
    border-color: #999;
    color: #333;
  }

  .view-mode-btn.active {
    border-color: #ff3e00;
    background: #ff3e00;
    color: #fff;
  }

  /* Clips scatter plot to rounded rect; outside is main's white background */
  .canvas-clip {
    position: absolute;
    top: 2%;
    left: 1%;
    width: 98%;
    height: 96%;
    border: 2px solid #d9d9d9;
    border-radius: 10px;
    overflow: hidden;
    z-index: 0;
  }

  .canvas-clip :global(.scatterplot-root) {
    width: 100%;
    height: 100%;
  }

  /* Detail panel inner (matches old app) */
  .detail-panel-inner {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 360px;
    min-height: 100%;
    padding: 1.5em;
    box-sizing: border-box;
  }

  .detail-panel-inner h3 {
    margin: 0 0 0.5em 0;
    color: #333;
    font-size: 1em;
    font-weight: 600;
  }

  .detail-panel-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75em;
    margin-top: auto;
    padding-top: 1em;
  }

  .detail-panel-footer h3 {
    margin: 0;
    color: #333;
    font-size: 1em;
    font-weight: 600;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .channel-slug {
    word-break: break-all;
    color: #666;
    font-size: 0.9em;
    margin: 0.25em 0;
  }

  .detail-placeholder,
  .detail-panel-inner p {
    color: #666;
    font-size: 0.95em;
    margin: 0.25em 0;
  }

  .detail-panel-inner .meta {
    font-size: 0.8rem;
    color: #888;
  }

  .back-btn {
    margin-top: 0.75rem;
    padding: 0.6rem 1rem;
    font-size: 0.9rem;
    font-weight: 600;
    color: white;
    background: #ff3e00;
    border: none;
    border-radius: 10px;
    cursor: pointer;
  }

  .back-btn:hover {
    background: #e63900;
  }

  .detail-image-wrap {
    display: block;
    flex: 1;
    min-height: 0;
    margin-bottom: 0;
  }

  .detail-image {
    display: block;
    width: 100%;
    height: auto;
    max-height: min(35vh, 280px);
    object-fit: contain;
    border-radius: 8px;
  }

  .close-btn {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    background: transparent;
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    transition: color 0.2s;
    color: #666;
  }

  .close-btn:hover {
    color: #ff3e00;
  }
</style>
