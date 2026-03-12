<script>
  export let pipelineProgress;
  export let clipPreloadProgress = {
    active: false,
    message: '',
    loaded: null,
    total: null,
    percent: null,
    status: null,
    file: null,
    ready: false,
  };
  export let progressPercent = 0;
  export let elapsedSeconds = 0;
  export let etaText = 'Estimating...';
</script>

<div class="loading">
  <p class="loading-title">{pipelineProgress.message}</p>
  <p class="loading-sub">
    Stage: {pipelineProgress.stage}
    {#if pipelineProgress.total}
      ({pipelineProgress.completed} / {pipelineProgress.total})
    {/if}
  </p>
  <div class="progress-bar">
    <div class="progress-fill" style={`width:${progressPercent}%`}></div>
  </div>
  <p class="loading-sub">{etaText} - elapsed {elapsedSeconds}s</p>
  {#if pipelineProgress.modelLoading || clipPreloadProgress.active}
    <p class="loading-sub">
      {clipPreloadProgress.message || 'Downloading CLIP model for first run...'}
    </p>
    <div class="progress-bar model-progress">
      <div
        class="progress-fill model-progress-fill"
        style={`width:${Math.max(0, Math.min(100, clipPreloadProgress.percent ?? pipelineProgress.modelDownloadPercent ?? 0))}%`}
      ></div>
    </div>
    {#if Number.isFinite(clipPreloadProgress.total ?? pipelineProgress.modelDownloadTotal)}
      <p class="loading-sub">
        {Math.round(clipPreloadProgress.percent ?? pipelineProgress.modelDownloadPercent ?? 0)}%
        ({(clipPreloadProgress.loaded ?? pipelineProgress.modelDownloadLoaded ?? 0).toLocaleString()} /
        {(clipPreloadProgress.total ?? pipelineProgress.modelDownloadTotal ?? 0).toLocaleString()} bytes)
      </p>
    {:else if clipPreloadProgress.status || pipelineProgress.modelDownloadStatus}
      <p class="loading-sub">{clipPreloadProgress.status || pipelineProgress.modelDownloadStatus}</p>
    {/if}
  {/if}
</div>

<style>
  .loading {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(540px, 92vw);
    border: 1px solid #ddd;
    border-radius: 12px;
    padding: 1rem 1.2rem;
    background: rgba(255, 255, 255, 0.9);
    backdrop-filter: blur(5px);
    z-index: 2;
  }

  .loading-title {
    margin: 0 0 0.45rem 0;
    font-weight: 700;
  }

  .loading-sub {
    margin: 0.3rem 0;
    color: #555;
    font-size: 0.92rem;
  }

  .progress-bar {
    width: 100%;
    height: 10px;
    background: #ececec;
    border-radius: 999px;
    overflow: hidden;
    margin: 0.6rem 0 0.4rem 0;
  }

  .progress-fill {
    height: 100%;
    background: #222;
    transition: width 0.15s linear;
  }

  .model-progress {
    height: 8px;
    margin-top: 0.35rem;
  }

  .model-progress-fill {
    background: #4a4a4a;
  }
</style>
