<script>
  export let error = '';
  export let onReset = () => {};
</script>

<div class="error">
  <p>Error: {error}</p>
  <button type="button" class="entry-btn" on:click={onReset}>
    Try another public channel
  </button>
</div>

<style>
  .error {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 1.2rem;
    background: #ffe0e0;
    color: #cc0000;
    border-radius: 10px;
    text-align: center;
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
</style>
