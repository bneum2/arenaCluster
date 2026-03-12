<script>
  export let channelInput = '';
  export let suggestedChannels = [];
  export let onSubmit = () => {};
  export let onSuggestion = () => {};
</script>

<div class="entry-screen">
  <h1 class="entry-title">Are.na channel</h1>
  <p class="entry-hint">Paste a public channel link or slug to visualize</p>
  <form class="entry-form" on:submit|preventDefault={onSubmit}>
    <input
      type="text"
      class="entry-input"
      placeholder="https://www.are.na/username/channel-slug or channel-slug"
      bind:value={channelInput}
      aria-label="Channel URL or slug"
    />
    <button type="submit" class="entry-btn">Cluster</button>
  </form>
  <p class="entry-suggestions-label">Suggested channels</p>
  <div class="entry-suggestions">
    {#each suggestedChannels as channel}
      <button type="button" class="entry-suggestion" on:click={() => onSuggestion(channel)}>
        {channel}
      </button>
    {/each}
  </div>
</div>

<style>
  .entry-screen {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }

  .entry-title {
    margin: 0 0 0.25em 0;
    color: #333;
    font-size: 1.8rem;
  }

  .entry-hint {
    margin: 0 0 1.2rem 0;
    color: #666;
  }

  .entry-form {
    width: 100%;
    max-width: 460px;
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    align-items: center;
  }

  .entry-input {
    width: 100%;
    padding: 0.7rem 0.95rem;
    border: 2px solid #d9d9d9;
    border-radius: 10px;
    box-sizing: border-box;
    font-size: 1rem;
  }

  .entry-btn {
    padding: 0.6rem 1.6rem;
    font-size: 1rem;
    color: white;
    background: #ff3e00;
    border: 0;
    border-radius: 10px;
    cursor: pointer;
    font-weight: 600;
  }

  .entry-suggestions-label {
    margin: 2rem 0 0.5rem 0;
    color: #666;
    font-size: 0.9rem;
  }

  .entry-suggestions {
    display: flex;
    gap: 0.7rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .entry-suggestion {
    padding: 0.5rem 1rem;
    border: 2px solid #e0e0e0;
    border-radius: 10px;
    background: #f5f5f5;
    cursor: pointer;
  }
</style>
