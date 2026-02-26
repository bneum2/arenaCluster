# 🎨 CLIP Integration Guide

This project uses CLIP embeddings to cluster Are.na blocks by semantic similarity - images and text together!

## Quick Setup (5 minutes)

### Option 1: Hugging Face (FREE)

1. **Get API Key**
   - Go to: https://huggingface.co/settings/tokens
   - Click "New token"
   - Copy your token

2. **Add to Code**
   - Open `App.svelte`
   - Find line ~22: `const HF_API_KEY = "";`
   - Paste your key: `const HF_API_KEY = "hf_xxxxxxxxxxxxx";`

3. **Run**
   ```bash
   npm run dev
   ```

That's it! Blocks will now cluster by similarity.

## How It Works

1. **Fetch Blocks** - Gets all blocks from your Are.na channel
2. **Generate Embeddings**:
   - Images → CLIP image encoder
   - Text → CLIP text encoder
   - Both use the same embedding space!
3. **Reduce to 2D** - Projects high-dimensional embeddings to 2D coordinates
4. **Visualize** - Similar blocks appear close together

## What You'll See

- **Images** = Circular thumbnails
- **Text** = 📝 circles
- **Links** = 🔗 circles
- **Position** = Similarity (closer = more similar)

## Alternative APIs

### Option 2: Replicate

```javascript
const REPLICATE_API_KEY = "r8_xxxxx";

async function getCLIPEmbedding(input, type) {
  const response = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${REPLICATE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      version: "clip-vit-large-patch14",
      input: { [type]: input }
    })
  });
  // ... handle response
}
```

### Option 3: OpenAI

```javascript
const OPENAI_API_KEY = "sk-xxxxx";

async function getEmbedding(text) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text
    })
  });
  // Note: OpenAI doesn't do images, only text
}
```

### Option 4: Local Python Backend

Run CLIP locally for free (no API limits):

```python
# backend.py
from flask import Flask, request, jsonify
from PIL import Image
import clip
import torch

app = Flask(__name__)
model, preprocess = clip.load("ViT-B/32")

@app.route('/embed/text', methods=['POST'])
def embed_text():
    text = request.json['text']
    with torch.no_grad():
        embedding = model.encode_text(clip.tokenize([text]))
    return jsonify(embedding.tolist())

@app.route('/embed/image', methods=['POST'])
def embed_image():
    image_url = request.json['image_url']
    image = preprocess(Image.open(image_url)).unsqueeze(0)
    with torch.no_grad():
        embedding = model.encode_image(image)
    return jsonify(embedding.tolist())

if __name__ == '__main__':
    app.run(port=5000)
```

Then update the frontend to call `http://localhost:5000/embed/text` or `/embed/image`.

## Improving the Visualization

### Better Dimensionality Reduction

The current implementation uses simple PCA-like projection. For better clustering:

**Add t-SNE:**
```bash
npm install ml-tsne
```

```javascript
import { TSNE } from 'ml-tsne';

function reduceTo2D(embeddings) {
  const tsne = new TSNE({
    dim: 2,
    perplexity: 30,
    learningRate: 10,
    nIter: 1000
  });
  
  return tsne.run(embeddings);
}
```

**Or use UMAP** (better for large datasets):
```bash
npm install umap-js
```

```javascript
import { UMAP } from 'umap-js';

function reduceTo2D(embeddings) {
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: 15,
    minDist: 0.1
  });
  
  return umap.fit(embeddings);
}
```

## Troubleshooting

**"No API key detected"**
- Make sure you set `HF_API_KEY` in the code
- Reload the page after adding it

**Blocks all in one corner**
- This can happen with the simple PCA fallback
- Add proper t-SNE/UMAP for better spreading

**Slow loading**
- Embeddings API calls take time
- Progress bar shows status
- Consider caching embeddings locally

**Rate limits**
- Hugging Face free tier: ~1000 requests/hour
- Add delays between requests (already implemented)
- Or use local backend for unlimited requests

## Next Steps

1. **Cache embeddings** - Store in localStorage to avoid re-computing
2. **Add clustering colors** - Color blocks by detected clusters
3. **Interactive filtering** - Filter by type, date, or cluster
4. **Search** - Find similar blocks to a query
5. **Export** - Save the layout as an image

Enjoy exploring your Are.na collection! 🎨
