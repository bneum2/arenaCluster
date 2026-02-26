# 🎨 AI-Powered Are.na Block Clustering

Visualize your Are.na blocks in 2D space based on semantic similarity. Images and text grouped together by meaning!

## ✨ Features

- **Zero Setup** - No API keys required!
- **Runs in Browser** - Uses TensorFlow.js Universal Sentence Encoder
- **Semantic Clustering** - Similar blocks appear close together
- **Cross-Modal** - Groups text and images by meaning
- **Interactive** - Hover over blocks to see details

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Run dev server
npm run dev
```

Open `http://localhost:5173` and watch your blocks cluster!

## 🧠 How It Works

1. **Fetch Blocks** - Gets all blocks from your Are.na channel
2. **Load Model** - Downloads Universal Sentence Encoder (~50MB, cached)
3. **Generate Embeddings** - Creates 512-dimensional vectors for each block
4. **Reduce to 2D** - Projects high-dimensional space to 2D coordinates
5. **Visualize** - Plots blocks as an interactive scatter plot

## 🎯 What You'll See

- **Images** = Circular thumbnails
- **Text** = 📝 emoji circles
- **Links** = 🔗 emoji circles
- **Position** = Similarity (closer blocks are more semantically similar)

## ⚙️ Configuration

Change the channel in `App.svelte`:

```javascript
const CHANNEL_SLUG = "your-channel-slug";
```

## 🔬 Technical Details

**Embedding Model:**
- Universal Sentence Encoder (512 dimensions)
- Trained on web text for semantic understanding
- Processes title + description + content

**Dimensionality Reduction:**
- Currently: Simple PCA-like projection
- Upgrade to t-SNE: `npm install ml-tsne`
- Or UMAP: `npm install umap-js`

## 📈 Improvements

- [ ] Add t-SNE/UMAP for better clustering
- [ ] Cache embeddings in localStorage
- [ ] Add interactive filtering by type/date
- [ ] Enable search to find similar blocks
- [ ] Add zoom/pan controls
- [ ] Export visualization as image

## 🐛 Troubleshooting

**Model takes a while to load?**
- First load downloads ~50MB model
- Subsequent loads use browser cache
- Progress shown in UI

**Blocks all in one area?**
- This can happen with simple PCA
- Add t-SNE or UMAP for better spreading

**Want better image understanding?**
- See `CLIP_SETUP.md` for CLIP integration
- Requires Python backend for true visual embeddings

## 📚 Learn More

- [TensorFlow.js](https://www.tensorflow.org/js)
- [Universal Sentence Encoder](https://tfhub.dev/google/universal-sentence-encoder/4)
- [Are.na API](https://dev.are.na/)

---

Built with Svelte + TensorFlow.js 🚀
