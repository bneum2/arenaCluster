<script>
  export let block = null;
</script>

{#if block}
  <aside class="hover-card">
    <img src={block.thumbUrl} alt={block.title || block.id} />
    <h3>{block.title || 'Untitled image block'}</h3>
    <p>{block.description || 'No description available.'}</p>
    <p class="meta">{block.createdAt}</p>
    <a href={block.originalUrl} target="_blank" rel="noreferrer">Open original image</a>
    {#if block.sourceUrl}
      <a href={block.sourceUrl} target="_blank" rel="noreferrer">Open source URL</a>
    {/if}
    <a href={`https://www.are.na/block/${block.id}`} target="_blank" rel="noreferrer">Open Are.na block</a>
  </aside>
{/if}

<style>
  .hover-card {
    position: absolute;
    right: 1rem;
    bottom: 1rem;
    width: 300px;
    max-height: 70vh;
    overflow: auto;
    background: #fff;
    border: 1px solid #ddd;
    border-radius: 10px;
    padding: 0.8rem;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.12);
  }

  .hover-card img {
    width: 100%;
    border-radius: 8px;
    display: block;
  }

  .hover-card h3 {
    margin: 0.6rem 0 0.35rem 0;
    font-size: 1rem;
  }

  .hover-card p {
    margin: 0.25rem 0;
    color: #555;
    font-size: 0.9rem;
  }

  .hover-card .meta {
    font-size: 0.8rem;
    color: #777;
  }

  .hover-card a {
    display: block;
    margin-top: 0.5rem;
    color: #1557c2;
    text-decoration: none;
    font-size: 0.9rem;
  }
</style>
