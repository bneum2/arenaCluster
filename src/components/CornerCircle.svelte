<script>
  export let corner = 'top-right'; // 'top-left' | 'top-right' | 'bottom-right'
  export let expanded = false;
  export let onToggle = () => {};
  export let label = '';

  $: positionClass = `corner-${corner}`;
</script>

<button
  type="button"
  class="detail-panel-circle-wrap {positionClass}"
  class:expanded
  on:click|stopPropagation={() => onToggle()}
  on:keydown={(e) => e.key === 'Enter' && onToggle()}
  aria-label={label || (expanded ? 'Collapse' : 'Expand')}
  aria-expanded={expanded}
>
  <span class="corner-circle-content">
    <slot />
  </span>
</button>

<style>
  /* Anchor: same position for circle and expanded panel (matches old app) */
  .detail-panel-circle-wrap {
    position: absolute;
    z-index: 1001;
    width: 20px;
    height: 20px;
    min-width: 20px;
    min-height: 20px;
    padding: 0;
    border: 2px solid #d9d9d9;
    border-radius: 10px;
    background: white;
    cursor: pointer;
    box-sizing: border-box;
    overflow: hidden;
    transition: width 0.3s ease-out, height 0.35s ease-out, border-radius 0.3s ease-out;
    display: flex;
    align-items: stretch;
    justify-content: stretch;
  }

  .detail-panel-circle-wrap.corner-top-left {
    top: 4%;
    left: 2%;
  }

  .detail-panel-circle-wrap.corner-top-right {
    top: 4%;
    right: 2%;
    left: auto;
  }

  .detail-panel-circle-wrap.corner-bottom-right {
    bottom: 4%;
    right: 2%;
    top: auto;
    left: auto;
  }

  /* Bottom-left is reserved for minimap - no circle in this component */

  .detail-panel-circle-wrap.expanded {
    width: 360px;
    height: 40vh;
    max-width: calc(100vw - 6%);
    border-radius: 10px;
    overflow-y: auto;
  }

  .corner-circle-content {
    display: none;
    flex: 1;
    overflow-y: auto;
    min-width: 0;
    min-height: 0;
  }

  .detail-panel-circle-wrap.expanded .corner-circle-content {
    display: block;
  }
</style>
