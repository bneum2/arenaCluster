<!--
  🎨 AI-Powered Are.na Block Clustering
  
  This app visualizes Are.na blocks in 2D space based on semantic similarity.
  Images and text are grouped together by meaning using AI embeddings.
  
  FEATURES:
  ✓ No setup required - runs entirely in your browser!
  ✓ Uses TensorFlow.js Universal Sentence Encoder
  ✓ 512-dimensional semantic embeddings
  ✓ Groups similar content together (text + images)
  
  HOW IT WORKS:
  1. Fetches all blocks from your Are.na channel
  2. Loads Universal Sentence Encoder model (~50MB)
  3. Generates embeddings for each block's text content
  4. Reduces high-dimensional embeddings to 2D using PCA
  5. Plots blocks - similar items appear close together!
  
  IMPROVEMENTS:
  - Add t-SNE or UMAP for better clustering
  - Use CLIP via Python backend for true visual embeddings
  - Cache embeddings in localStorage
  - Add interactive filtering and search
-->

<script>
  import { onMount, tick } from 'svelte';
  import Arena from 'are.na';
  import * as tf from '@tensorflow/tfjs';
  import * as use from '@tensorflow-models/universal-sentence-encoder';

  let loading = false;
  let error = null;
  let blocks = [];
  let positionedBlocks = [];
  let stats = {
    total: 0,
    images: 0,
    text: 0,
    other: 0,
    gifsSkipped: 0
  };

  const SUGGESTED_CHANNELS = [
    { slug: 'kit-madness' },
    { slug: 'best-textures' },
    { slug: 'idk-n-yi8fdktls' },
  ];

  /** Cache of preloaded channel data (slug -> { blocks, stats, positionedBlocks }) */
  let channelCache = {};

  let channelSlug = null; // set when user enters a link or picks a suggestion
  let channelInput = '';

  /** Extract channel slug from Are.na URL (e.g. https://www.are.na/ben-neumaier/idk-n-yi8fdktls) or return as-is if already a slug */
  function slugFromInput(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) return null;
    try {
      const url = trimmed.startsWith('http') ? new URL(trimmed) : null;
      if (url && url.hostname.includes('are.na')) {
        const parts = url.pathname.split('/').filter(Boolean);
        return parts.length >= 1 ? parts[parts.length - 1] : null;
      }
      return trimmed; // treat as slug
    } catch {
      return trimmed;
    }
  }

  function loadChannel(slug) {
    const s = slug || slugFromInput(channelInput);
    if (!s) return;
    channelInput = '';
    if (channelCache[s]) {
      channelSlug = s;
      blocks = channelCache[s].blocks;
      stats = channelCache[s].stats;
      positionedBlocks = channelCache[s].positionedBlocks;
      error = null;
      setTimeout(() => autoFitView(), 100);
      return;
    }
    channelSlug = s;
    fetchAllBlocks();
  }

  let canvasWidth = 0;
  let canvasHeight = 0;
  let hoveredBlock = null;
  let embeddingProgress = 0;
  let embeddingModel = null;
  let modelLoading = false;
  
  // Pan and zoom controls
  let viewBox = { x: 0, y: 0, width: 1000, height: 800 };
  let scale = 1;
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  const NUM_PANELS = 4; // corners: 0=TL, 1=TR, 2=BL, 3=BR
  let selectedBlocks = [null, null, null, null];
  let panelExpanded = [false, false, false, false];
  let detailPanelEls = [null, null, null, null];

  function isBlockSelected(block) {
    return selectedBlocks.some(b => b && b.id === block.id);
  }

  $: selectedBlocks;
  $: for (let i = 0; i < NUM_PANELS; i++) {
    if (!selectedBlocks[i]) panelExpanded[i] = false;
  }

  async function openPanelAt(slotIndex) {
    panelExpanded[slotIndex] = false;
    await tick();
    requestAnimationFrame(() => { panelExpanded[slotIndex] = true; });
  }

  function closePanel(i) {
    panelExpanded[i] = false;
    const panel = detailPanelEls[i];
    if (panel) {
      const onTransitionEnd = (e) => {
        if (e.propertyName === 'height') {
          panel.removeEventListener('transitionend', onTransitionEnd);
          selectedBlocks[i] = null;
          selectedBlocks = selectedBlocks;
        }
      };
      panel.addEventListener('transitionend', onTransitionEnd);
    } else {
      selectedBlocks[i] = null;
    }
  }
  let showImageThumbnails = true; // Toggle to hide images for better performance
  let hoveredBlockId = null;
  let clusterRotationAngle = 0;

  // Group blocks by cluster for per-cluster rotation
  $: clusters = (() => {
    const byId = {};
    for (const block of positionedBlocks) {
      const cid = block.clusterId;
      if (byId[cid] == null) {
        byId[cid] = { clusterId: cid, centerX: block.clusterCenterX, centerY: block.clusterCenterY, blocks: [] };
      }
      byId[cid].blocks.push(block);
    }
    return Object.values(byId);
  })();

  /** Fetch and position channel data for a given slug. Returns { blocks, stats, positionedBlocks } (does not update UI). */
  async function fetchChannelData(slug) {
    const arena = new Arena();
    const firstPage = await arena.channel(slug).get({ page: 1, per: 100 });
    const totalBlocks = firstPage.length;
    const totalPages = Math.ceil(totalBlocks / 100);
    let allBlocks = [...(firstPage.contents || [])];
    const maxPages = Math.min(totalPages, 5);
    for (let page = 2; page <= maxPages; page++) {
      const pageData = await arena.channel(slug).get({ page, per: 100 });
      allBlocks.push(...(pageData.contents || []));
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    const processedBlocks = allBlocks.map(block => {
      const imageUrl = block.image?.thumb?.url || block.image?.display?.url || block.image?.large?.url;
      const isGif = imageUrl && (imageUrl.toLowerCase().endsWith('.gif') || imageUrl.includes('.gif?'));
      return {
        id: block.id,
        type: block.class,
        title: block.title || '',
        description: block.description || '',
        content: block.content || block.content_html || '',
        image: isGif ? null : imageUrl,
        isGif: isGif,
        source: block.source?.url,
        created: new Date(block.created_at),
        textContent: [
          block.title,
          block.description,
          block.content,
          block.class === 'Link' ? block.source?.url : ''
        ].filter(Boolean).join(' ').substring(0, 1000)
      };
    }).filter(b => !b.isGif);
    const channelStats = {
      total: processedBlocks.length,
      images: processedBlocks.filter(b => b.type === 'Image').length,
      text: processedBlocks.filter(b => b.type === 'Text').length,
      other: processedBlocks.filter(b => !['Image', 'Text'].includes(b.type)).length
    };
    const imageBlocks = processedBlocks.filter(b => b.type === 'Image');
    const positioned = await positionBlocksWithKMeans(imageBlocks);
    return { blocks: processedBlocks, stats: channelStats, positionedBlocks: positioned };
  }

  // Fetch all blocks from the channel
  async function fetchAllBlocks() {
    try {
      loading = true;
      const data = await fetchChannelData(channelSlug);
      blocks = data.blocks;
      stats = data.stats;
      positionedBlocks = data.positionedBlocks;
      channelCache[channelSlug] = data;
      setTimeout(() => autoFitView(), 100);
    } catch (err) {
      console.error('Error fetching blocks:', err);
      error = err.message;
    } finally {
      loading = false;
    }
  }

  // Load the text embedding model
  async function loadModel() {
    if (embeddingModel) return embeddingModel;
    
    console.log('📦 Loading AI model...');
    modelLoading = true;
    
    try {
      // Check if TensorFlow.js is loaded
      if (typeof tf === 'undefined' || !tf.ready) {
        throw new Error('TensorFlow.js not properly imported');
      }
      
      // Initialize TensorFlow.js backend explicitly
      console.log('🔧 Initializing TensorFlow.js backend...');
      
      // Wait for TensorFlow to be ready
      await tf.ready();
      console.log('✓ TensorFlow.js ready');
      
      // Try to set CPU backend (most reliable for browser)
      const currentBackend = tf.getBackend();
      if (!currentBackend) {
        try {
          await tf.setBackend('cpu');
          await tf.ready();
          console.log('✓ Set CPU backend');
        } catch (backendErr) {
          console.warn('Could not set CPU backend, using default:', backendErr);
        }
      }
      
      // Verify backend is set
      const backend = tf.getBackend();
      if (!backend) {
        throw new Error('No TensorFlow.js backend available. Try refreshing the page.');
      }
      
      console.log('✓ Using backend:', backend);
      
      // Load text embedding model
      console.log('📥 Loading Universal Sentence Encoder for text (~50MB)...');
      embeddingModel = await use.load();
      console.log('✓ Text model loaded!');
      console.log('✓ Image analysis will use direct visual feature extraction');
      
      modelLoading = false;
      return embeddingModel;
    } catch (err) {
      console.error('❌ Error loading model:', err);
      console.error('Error message:', err.message);
      if (err.stack) {
        console.error('Stack trace:', err.stack);
      }
      console.warn('⚠️ Falling back to simple keyword-based features');
      modelLoading = false;
      return null;
    }
  }

  // Get text embeddings using TensorFlow.js Universal Sentence Encoder
  async function getTextEmbedding(text) {
    if (!embeddingModel) {
      return null;
    }

    try {
      // Clean and truncate text
      const cleanText = text.substring(0, 500).trim();
      if (cleanText.length < 3) return null;
      
      // Get embedding
      const embeddings = await embeddingModel.embed([cleanText]);
      const embeddingArray = await embeddings.array();
      
      // Clean up tensor
      embeddings.dispose();
      
      // Return the embedding vector (512 dimensions)
      return embeddingArray[0];
    } catch (err) {
      console.error('Error getting text embedding:', err);
      return null;
    }
  }

  // Fast color extraction: 3 most common colors (9-D). Uses small resize + few k-means iters for speed.
  async function getColorFeatures(imageUrl) {
    if (!imageUrl || typeof tf === 'undefined') return null;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = imageUrl;
      });
      const imageTensor = tf.browser.fromPixels(img);
      const size = 32; // smaller = faster (was 64)
      const resized = tf.image.resizeBilinear(imageTensor, [size, size]);
      const pixels = await resized.reshape([size * size, 3]).array();
      imageTensor.dispose();
      resized.dispose();
      const sampled = pixels.filter((_, i) => i % 2 === 0); // every 2nd pixel
      const { clusters, centroids } = simpleKMeans(sampled, 3, 12); // fewer iters (was 25)
      const counts = [0, 1, 2].map(j => clusters.filter(c => c === j).length);
      const order = [0, 1, 2].sort((a, b) => counts[b] - counts[a]);
      const sortedCentroids = order.map(i => centroids[i]);
      return sortedCentroids.flat();
    } catch (err) {
      return null;
    }
  }

  // Get visual embeddings from images using direct TensorFlow.js feature extraction
  async function getImageEmbedding(imageUrl) {
    if (!imageUrl || typeof tf === 'undefined') {
      return null;
    }

    try {
      // Load image
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = imageUrl;
      });
      
      // Convert image to tensor
      const imageTensor = tf.browser.fromPixels(img);
      
      // Resize to standard size for processing (224x224)
      const resized = tf.image.resizeBilinear(imageTensor, [224, 224]);
      
      // Extract visual features
      const features = [];
      
      // 1. Color histogram (RGB channels)
      const mean = resized.mean([0, 1]); // Average color
      const meanData = await mean.array();
      features.push(...meanData); // 3 values (R, G, B)
      
      // 2. Brightness distribution
      const gray = tf.image.rgbToGrayscale(resized);
      const grayMean = gray.mean();
      const grayStd = gray.sub(grayMean).square().mean().sqrt();
      const [brightness, contrast] = await Promise.all([
        grayMean.array(),
        grayStd.array()
      ]);
      features.push(brightness, contrast); // 2 values
      
      // 3. Color variance (how varied the colors are)
      const variance = resized.sub(mean.expandDims(0).expandDims(0)).square().mean([0, 1]);
      const varianceData = await variance.array();
      features.push(...varianceData); // 3 values
      
      // 4. Spatial features (center vs edges)
      const centerCrop = tf.image.cropAndResize(
        resized.expandDims(0),
        [[0.25, 0.25, 0.75, 0.75]],
        [0],
        [112, 112]
      );
      const centerMean = centerCrop.mean([1, 2]);
      const centerData = await centerMean.array();
      features.push(...centerData[0]); // 3 values
      
      // 5. Edge features (simplified - using gradient differences)
      const graySqueezed = gray.squeeze([2]);
      const diffX = graySqueezed.slice([0, 0], [224, 223]).sub(graySqueezed.slice([0, 1], [224, 223]));
      const diffY = graySqueezed.slice([0, 0], [223, 224]).sub(graySqueezed.slice([1, 0], [223, 224]));
      const edgeStrengthX = await diffX.abs().mean().array();
      const edgeStrengthY = await diffY.abs().mean().array();
      features.push(edgeStrengthX, edgeStrengthY); // 2 values
      
      // 6. Texture features (local variance in grayscale)
      const localVar = gray.sub(gray.mean()).square().mean();
      const texture = await localVar.array();
      features.push(texture); // 1 value
      
      // Clean up tensors
      imageTensor.dispose();
      resized.dispose();
      gray.dispose();
      mean.dispose();
      variance.dispose();
      centerCrop.dispose();
      centerMean.dispose();
      graySqueezed.dispose();
      diffX.dispose();
      diffY.dispose();
      localVar.dispose();
      
      // Pad to 512 dimensions to match text embeddings
      while (features.length < 512) {
        features.push(0);
      }
      
      // Normalize to unit vector
      const magnitude = Math.sqrt(features.reduce((sum, val) => sum + val * val, 0));
      if (magnitude > 0) {
        return features.slice(0, 512).map(val => val / magnitude);
      }
      
      return features.slice(0, 512);
    } catch (err) {
      console.error('Error getting image embedding:', err);
      return null;
    }
  }

  // Combine image and text embeddings for unified representation
  async function getCombinedEmbedding(block) {
    let imageEmbedding = null;
    let textEmbedding = null;
    
    // Get image visual features if available (using direct TensorFlow.js)
    if (block.image) {
      imageEmbedding = await getImageEmbedding(block.image);
    }
    
    // Get text embedding
    const textToEmbed = [
      block.title,
      block.description,
      block.type === 'Image' ? `Image: ${block.title || 'visual content'}` : block.textContent.substring(0, 300)
    ].filter(Boolean).join('. ');
    
    if (textToEmbed.length > 10 && embeddingModel) {
      textEmbedding = await getTextEmbedding(textToEmbed);
    }
    
    // Combine embeddings (weighted average)
    if (imageEmbedding && textEmbedding) {
      // Both available: combine them (60% visual, 40% text for images)
      return imageEmbedding.map((imgVal, i) => 
        0.6 * imgVal + 0.4 * (textEmbedding[i] || 0)
      );
    } else if (imageEmbedding) {
      // Only image visual features
      return imageEmbedding;
    } else if (textEmbedding) {
      // Only text
      return textEmbedding;
    }
    
    return null;
  }

  // Extract visual features from image blocks (color, brightness, etc.)
  function getImageFeatures(block) {
    // For images, create feature vector based on available metadata
    const features = [];
    
    // Use text content if available
    const text = block.textContent || '';
    
    // Image-specific keywords
    const imageKeywords = ['photo', 'picture', 'image', 'art', 'design', 'illustration', 'graphic'];
    imageKeywords.forEach(keyword => {
      features.push(text.toLowerCase().includes(keyword) ? 1 : 0);
    });
    
    // Has description
    features.push(block.description ? 1 : 0);
    
    // Title length (normalized)
    features.push(Math.min((block.title?.length || 0) / 50, 1));
    
    // Description length (normalized)
    features.push(Math.min((block.description?.length || 0) / 200, 1));
    
    // Pad to match embedding dimensions (512 for Universal Sentence Encoder)
    while (features.length < 512) {
      features.push(0);
    }
    
    return features.slice(0, 512);
  }

  // Fallback: Simple feature extraction without model
  function getSimpleFeatures(block) {
    const features = [];
    
    // Text features (simple bag of words)
    const text = block.textContent.toLowerCase();
    const keywords = ['design', 'art', 'photo', 'web', 'code', 'music', 'video', 'text', 'image'];
    keywords.forEach(keyword => {
      features.push(text.includes(keyword) ? 1 : 0);
    });
    
    // Type features
    features.push(block.type === 'Image' ? 1 : 0);
    features.push(block.type === 'Text' ? 1 : 0);
    features.push(block.type === 'Link' ? 1 : 0);
    
    // Content length
    features.push(Math.min(block.textContent.length / 1000, 1));
    
    // Has image
    features.push(block.image ? 1 : 0);
    
    // Pad to 512 dimensions
    while (features.length < 512) {
      features.push(0);
    }
    
    return features.slice(0, 512);
  }

  // Simple PCA-like dimensionality reduction
  function reduceTo2D(embeddings) {
    // Center the data
    const mean = embeddings[0].map((_, dim) => {
      return embeddings.reduce((sum, emb) => sum + emb[dim], 0) / embeddings.length;
    });
    
    const centered = embeddings.map(emb => 
      emb.map((val, dim) => val - mean[dim])
    );
    
    // Project onto first 2 principal components (simplified)
    // For real PCA, you'd compute covariance matrix and eigenvectors
    // This is a simplified projection
    const coords = centered.map(emb => {
      const x = emb.reduce((sum, val, i) => sum + val * Math.cos(i), 0);
      const y = emb.reduce((sum, val, i) => sum + val * Math.sin(i), 0);
      return [x, y];
    });
    
    // Normalize to 0-1 range
    const xValues = coords.map(c => c[0]);
    const yValues = coords.map(c => c[1]);
    const xMin = Math.min(...xValues);
    const xMax = Math.max(...xValues);
    const yMin = Math.min(...yValues);
    const yMax = Math.max(...yValues);
    
    return coords.map(([x, y]) => [
      (x - xMin) / (xMax - xMin),
      (y - yMin) / (yMax - yMin)
    ]);
  }

  // Simple k-means clustering implementation
  function simpleKMeans(data, k, maxIterations = 100) {
    if (data.length === 0) return { clusters: [], centroids: [] };
    
    const n = data.length;
    const dim = data[0].length;
    
    // Initialize centroids randomly
    let centroids = [];
    for (let i = 0; i < k; i++) {
      const randomIndex = Math.floor(Math.random() * n);
      centroids.push([...data[randomIndex]]);
    }
    
    let clusters = new Array(n).fill(0);
    let changed = true;
    let iterations = 0;
    
    while (changed && iterations < maxIterations) {
      changed = false;
      
      // Assign points to nearest centroid
      for (let i = 0; i < n; i++) {
        let minDist = Infinity;
        let closest = 0;
        
        for (let j = 0; j < k; j++) {
          // Euclidean distance
          let dist = 0;
          for (let d = 0; d < dim; d++) {
            const diff = data[i][d] - centroids[j][d];
            dist += diff * diff;
          }
          dist = Math.sqrt(dist);
          
          if (dist < minDist) {
            minDist = dist;
            closest = j;
          }
        }
        
        if (clusters[i] !== closest) {
          clusters[i] = closest;
          changed = true;
        }
      }
      
      // Update centroids
      for (let j = 0; j < k; j++) {
        const clusterPoints = data.filter((_, i) => clusters[i] === j);
        if (clusterPoints.length > 0) {
          const newCentroid = new Array(dim).fill(0);
          clusterPoints.forEach(point => {
            for (let d = 0; d < dim; d++) {
              newCentroid[d] += point[d];
            }
          });
          centroids[j] = newCentroid.map(sum => sum / clusterPoints.length);
        }
      }
      
      iterations++;
    }
    
    return { clusters, centroids };
  }

  const COLOR_FEATURE_BATCH_SIZE = 10; // parallel image loads per batch

  // Fast k-means clustering by color
  async function positionBlocksWithKMeans(blocks) {
    console.log('🎨 Fast color-based clustering for', blocks.length, 'blocks...');
    
    const features = [];
    const featureBlocks = [];
    
    // Extract color features in parallel batches (much faster than one-by-one)
    for (let start = 0; start < blocks.length; start += COLOR_FEATURE_BATCH_SIZE) {
      const end = Math.min(start + COLOR_FEATURE_BATCH_SIZE, blocks.length);
      embeddingProgress = Math.round((end / blocks.length) * 50);
      
      const batch = await Promise.all(
        blocks.slice(start, end).map(async (block) => {
          let feature = null;
          if (block.image) feature = await getColorFeatures(block.image);
          if (!feature) {
            feature = [
              block.type === 'Image' ? 1 : 0,
              block.type === 'Text' ? 1 : 0,
              block.type === 'Link' ? 1 : 0,
              block.image ? 1 : 0,
              Math.min(block.textContent.length / 1000, 1),
              0, 0, 0, 0
            ];
          }
          return { feature, block };
        })
      );
      
      batch.forEach(({ feature, block }) => {
        features.push(feature);
        featureBlocks.push(block);
      });
      
      if (end < blocks.length) {
        await new Promise(r => requestAnimationFrame(r)); // yield to UI between batches
      }
    }
    
    console.log('✓ Color features extracted, running k-means...');
    embeddingProgress = 75;
    
    const numClusters = Math.min(Math.max(5, Math.floor(blocks.length / 20)), 15);
    const result = simpleKMeans(features, numClusters, 50); // 50 iters usually enough (was 100)
    
    console.log(`✓ K-means complete: ${numClusters} color clusters found`);
    embeddingProgress = 90;
    
    // Position clusters in 2D space
    const clusterPositions = {};
    const clusterSizes = {};
    
    // Calculate cluster centers and sizes
    result.clusters.forEach((clusterId, i) => {
      if (!clusterPositions[clusterId]) {
        clusterPositions[clusterId] = { x: 0, y: 0, count: 0 };
      }
      clusterPositions[clusterId].count++;
      clusterSizes[clusterId] = (clusterSizes[clusterId] || 0) + 1;
    });
    
    // Arrange clusters in a circle with more spacing
    const clusterIds = Object.keys(clusterPositions).map(Number).sort((a, b) => a - b);
    const angleStep = (Math.PI * 2) / clusterIds.length;
    
    // Calculate base radius based on number of clusters and blocks
    const baseRadius = Math.max(300, Math.sqrt(blocks.length) * 30);
    
    clusterIds.forEach((clusterId, i) => {
      const angle = i * angleStep;
      // Increase radius based on cluster size, with more spacing
      const clusterSize = clusterSizes[clusterId] || 1;
      const radius = baseRadius + clusterSize * 25; // Increased from 10 to 25
      clusterPositions[clusterId].x = Math.cos(angle) * radius;
      clusterPositions[clusterId].y = Math.sin(angle) * radius;
    });
    
    // Group blocks by cluster for better spacing
    const blocksByCluster = {};
    featureBlocks.forEach((block, i) => {
      const clusterId = result.clusters[i];
      if (!blocksByCluster[clusterId]) {
        blocksByCluster[clusterId] = [];
      }
      blocksByCluster[clusterId].push({ block, originalIndex: i });
    });
    
    // Position blocks within their clusters with better spacing
    const positioned = featureBlocks.map((block, i) => {
      const clusterId = result.clusters[i];
      const clusterPos = clusterPositions[clusterId];
      const clusterBlocks = blocksByCluster[clusterId];
      const blockIndexInCluster = clusterBlocks.findIndex(item => item.originalIndex === i);
      const totalInCluster = clusterBlocks.length;
      
      // Spread blocks in a circle within the cluster
      let offsetX, offsetY;
      if (totalInCluster > 1) {
        const angle = (blockIndexInCluster / totalInCluster) * Math.PI * 2;
        // Increased spread radius for better spacing
        const spreadRadius = Math.min(150, Math.max(80, totalInCluster * 12));
        offsetX = Math.cos(angle) * spreadRadius;
        offsetY = Math.sin(angle) * spreadRadius;
      } else {
        // Single block in cluster - center it
        offsetX = 0;
        offsetY = 0;
      }

      // Angle from cluster center to this block (used for hover direction in template)
      const len = Math.sqrt(offsetX * offsetX + offsetY * offsetY);
      const hoverAngle = len > 0 ? Math.atan2(offsetY, offsetX) : -Math.PI / 2; // up if at center
      const centerX = clusterPos.x + (canvasWidth * .5);
      const centerY = clusterPos.y + (canvasHeight * .5);
      return {
        ...block,
        x: clusterPos.x + offsetX + (canvasWidth * .5),
        y: clusterPos.y + offsetY + (canvasHeight * .5),
        clusterId: clusterId,
        clusterCenterX: centerX,
        clusterCenterY: centerY,
        hoverAngle
      };
    });
    
    embeddingProgress = 100;
    console.log('✓ Blocks positioned by color clusters!');
    
    return positioned;
  }

  // Main positioning function with embeddings (slow but accurate)
  async function positionBlocksWithEmbeddings(blocks) {
    console.log('🤖 Getting embeddings for', blocks.length, 'blocks...');
    
    // Load the embedding model first
    await loadModel();
    
    if (!embeddingModel) {
      console.warn('⚠️ Model failed to load, using simple features');
    }
    
    const embeddings = [];
    let successCount = 0;
    let failCount = 0;
    
    // Get embeddings for each block
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      embeddingProgress = Math.round((i / blocks.length) * 100);
      
      let embedding = null;
      
      // Try to get combined embedding (image + text)
      if (embeddingModel) {
        embedding = await getCombinedEmbedding(block);
        
        if (embedding) {
          successCount++;
        } else {
          failCount++;
        }
      }
      
      // Fallback to simple features if model fails
      if (!embedding) {
        if (block.image) {
          embedding = getImageFeatures(block);
        } else {
          embedding = getSimpleFeatures(block);
        }
        failCount++;
      }
      
      embeddings.push(embedding);
      
      // Small delay to prevent overwhelming the browser
      if (i % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    
    console.log(`✓ Got embeddings: ${successCount} with AI models, ${failCount} fallback`);
    const imageCount = blocks.filter(b => b.image).length;
    if (imageCount > 0) {
      console.log(`✓ ${imageCount} images analyzed visually using TensorFlow.js`);
    }
    console.log('✓ Reducing to 2D...');
    
    // Reduce to 2D coordinates
    const coords2D = reduceTo2D(embeddings);
    
    // Map to canvas space
    return blocks.map((block, i) => ({
      ...block,
      x: coords2D[i][0] * (canvasWidth * 0.8) + canvasWidth * 0.1,
      y: coords2D[i][1] * (canvasHeight * 0.8) + canvasHeight * 0.1,
    }));
  }

  /* 
  // EXAMPLE: How you might integrate real AI embeddings
  async function positionBlocksWithEmbeddings(blocks) {
    // 1. Get embeddings for all blocks
    const embeddings = await Promise.all(blocks.map(async (block) => {
      // For images: use CLIP image encoder or similar
      // For text: use CLIP text encoder or text embedding model
      if (block.image) {
        return await getImageEmbedding(block.image);
      } else {
        return await getTextEmbedding(block.textContent);
      }
    }));
    
    // 2. Reduce to 2D using t-SNE or UMAP
    const coordinates = await reduce2D(embeddings);
    
    // 3. Scale to canvas size
    return blocks.map((block, i) => ({
      ...block,
      x: coordinates[i][0] * canvasWidth,
      y: coordinates[i][1] * canvasHeight,
    }));
  }
  */

  function handleMouseMove(event, block) {
    if (!isPanning) {
      hoveredBlock = block;
      hoveredBlockId = block.id;
    }
  }

  function handleMouseLeave() {
    // Don't clear hover: keep last block in hover state until a different block is hovered
  }

  function handleBlockClick(block) {
    const idx = selectedBlocks.findIndex(b => b && b.id === block.id);
    if (idx >= 0) {
      closePanel(idx);
      return;
    }
    let slot = selectedBlocks.findIndex(b => !b);
    if (slot < 0) slot = 0;
    selectedBlocks[slot] = block;
    selectedBlocks = selectedBlocks;
    openPanelAt(slot);
  }

  // Pan controls
  function handleMouseDown(event) {
    if (event.button === 0) { // Left click
      isPanning = true;
      panStart = { x: event.clientX, y: event.clientY };
      hoveredBlock = null;
    }
  }

  function handleMouseMoveCanvas(event) {
    if (isPanning) {
      const dx = (event.clientX - panStart.x) * (viewBox.width / canvasWidth);
      const dy = (event.clientY - panStart.y) * (viewBox.height / canvasHeight);
      
      viewBox.x -= dx;
      viewBox.y -= dy;
      
      panStart = { x: event.clientX, y: event.clientY };
    }
  }

  function handleMouseUp() {
    isPanning = false;
  }

  // Zoom controls
  function handleWheel(event) {
    event.preventDefault();
    
    const zoomIntensity = 0.1;
    const direction = event.deltaY > 0 ? 1 : -1;
    const factor = 1 + direction * zoomIntensity;
    
    // Get mouse position relative to SVG
    const rect = event.currentTarget.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    
    // Convert to viewBox coordinates
    const svgX = viewBox.x + (mouseX / canvasWidth) * viewBox.width;
    const svgY = viewBox.y + (mouseY / canvasHeight) * viewBox.height;
    
    // Zoom
    const newWidth = viewBox.width * factor;
    const newHeight = viewBox.height * factor;
    
    // Adjust position to zoom toward mouse
    viewBox.x = svgX - (mouseX / canvasWidth) * newWidth;
    viewBox.y = svgY - (mouseY / canvasHeight) * newHeight;
    viewBox.width = newWidth;
    viewBox.height = newHeight;
    
    scale = 1000 / viewBox.width;
  }

  function zoomIn() {
    const factor = 0.8;
    const centerX = viewBox.x + viewBox.width / 2;
    const centerY = viewBox.y + viewBox.height / 2;
    
    viewBox.width *= factor;
    viewBox.height *= factor;
    viewBox.x = centerX - viewBox.width / 2;
    viewBox.y = centerY - viewBox.height / 2;
    
    scale = 1000 / viewBox.width;
  }

  function zoomOut() {
    const factor = 1.25;
    const centerX = viewBox.x + viewBox.width / 2;
    const centerY = viewBox.y + viewBox.height / 2;
    
    viewBox.width *= factor;
    viewBox.height *= factor;
    viewBox.x = centerX - viewBox.width / 2;
    viewBox.y = centerY - viewBox.height / 2;
    
    scale = 1000 / viewBox.width;
  }

  function autoFitView() {
    if (positionedBlocks.length === 0) return;
    
    // Find bounds of all blocks
    const xs = positionedBlocks.map(b => b.x);
    const ys = positionedBlocks.map(b => b.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    
    // Add padding (20% on each side)
    const paddingX = (maxX - minX) * 0.2;
    const paddingY = (maxY - minY) * 0.2;
    
    viewBox = {
      x: minX - paddingX,
      y: minY - paddingY,
      width: (maxX - minX) + paddingX * 2,
      height: (maxY - minY) + paddingY * 2
    };
    
    scale = canvasWidth / viewBox.width;
  }

  function resetView() {
    if (positionedBlocks.length > 0) {
      autoFitView();
    } else {
      // Calculate appropriate viewBox based on canvas size
      const centerX = canvasWidth * 0.5;
      const centerY = canvasHeight * 0.5;
      const viewWidth = canvasWidth * 1.2; // Show 20% more space
      const viewHeight = canvasHeight * 1.2;
      
      viewBox = { 
        x: centerX - viewWidth * 0.5, 
        y: centerY - viewHeight * 0.5, 
        width: viewWidth, 
        height: viewHeight 
      };
      scale = 1;
    }
  }

  onMount(() => {
    // Set canvas size to full viewport
    canvasWidth = window.innerWidth;
    canvasHeight = window.innerHeight;
    
    // Update on resize
    const handleResize = () => {
      canvasWidth = window.innerWidth;
      canvasHeight = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);
    
    // Preload suggested channels so they load instantly when clicked
    for (const ch of SUGGESTED_CHANNELS) {
      fetchChannelData(ch.slug)
        .then((data) => {
          channelCache[ch.slug] = data;
          channelCache = channelCache;
        })
        .catch(() => {});
    }
    
    // Slow rotation for each cluster (degrees per frame ~= 0.1 → ~60s per full rotation)
    let rafId;
    function tickRotation() {
      clusterRotationAngle = (clusterRotationAngle + 0.03) % 360;
      rafId = requestAnimationFrame(tickRotation);
    }
    rafId = requestAnimationFrame(tickRotation);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(rafId);
    };
  });
</script>

<main>
  <div class="border"></div>

  <div class="content">
    {#if channelSlug === null}
      <!-- Entry: enter a channel link or pick a suggestion -->
      <div class="entry-screen">
        <h1 class="entry-title">Are.na channel</h1>
        <p class="entry-hint">Paste a channel link or slug to visualize</p>
        <form class="entry-form" on:submit|preventDefault={() => loadChannel()}>
          <input
            type="text"
            class="entry-input"
            placeholder="https://www.are.na/username/channel-slug or channel-slug"
            bind:value={channelInput}
            aria-label="Channel URL or slug"
          />
          <button type="submit" class="entry-btn">Load channel</button>
        </form>
        <p class="entry-suggestions-label">Suggested channels</p>
        <div class="entry-suggestions">
          {#each SUGGESTED_CHANNELS as ch}
            <button type="button" class="entry-suggestion" on:click={() => loadChannel(ch.slug)}>
              {ch.slug}
            </button>
          {/each}
        </div>
      </div>
    {:else if loading}
      <div class="loading">
        <div class="loading-dots">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
      </div>
    {:else if error}
      <div class="error">
        <p>Error: {error}</p>
        <button type="button" class="entry-btn" on:click={() => { error = null; channelSlug = null; }}>Try another channel</button>
      </div>
    {:else}
      <div class="canvas-container">

        <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
        <svg 
          width={canvasWidth} 
          height={canvasHeight}
          viewBox="{viewBox.x} {viewBox.y} {viewBox.width} {viewBox.height}"
          class="cluster-canvas"
          class:panning={isPanning}
          on:mousedown={handleMouseDown}
          on:mousemove={handleMouseMoveCanvas}
          on:mouseup={handleMouseUp}
          on:mouseleave={handleMouseUp}
          on:wheel={handleWheel}
          role="application"
          aria-label="Interactive visualization of Are.na blocks"
        >
          <!-- Draw blocks as circles/rects; each cluster rotates slowly around its center -->
          {#each clusters as cluster}
            <g transform="translate({cluster.centerX}, {cluster.centerY}) rotate({clusterRotationAngle})">
              {#each cluster.blocks as block}
                {@const isHovered = hoveredBlockId === block.id}
                {@const hoverDist = 18}
                {@const hoverDx = (isHovered && block.hoverAngle != null) ? Math.cos(block.hoverAngle) * hoverDist : 0}
                {@const hoverDy = (isHovered && block.hoverAngle != null) ? Math.sin(block.hoverAngle) * hoverDist : 0}
                <g 
                  class="block-node"
                  class:selected={isBlockSelected(block)}
                  class:hovered={isHovered}
                  transform={isHovered && block.hoverAngle != null
                    ? `translate(${block.x - cluster.centerX + hoverDx}, ${block.y - cluster.centerY + hoverDy}) rotate(${-clusterRotationAngle}) scale(1.3)`
                    : `translate(${block.x - cluster.centerX}, ${block.y - cluster.centerY}) rotate(${-clusterRotationAngle}) scale(1)`}
              on:mouseenter={(e) => handleMouseMove(e, block)}
              on:mouseleave={handleMouseLeave}
              on:mousedown|stopPropagation
              on:click={() => handleBlockClick(block)}
              on:keypress={(e) => e.key === 'Enter' && handleBlockClick(block)}
              role="button"
              tabindex="0"
              aria-label={block.title || 'Untitled block'}
            >
              <g class="block-content">
              <!-- Invisible hit area so block always gets hover/click and shows pointer cursor -->
              <circle cx="0" cy="0" r="35" fill="transparent" class="block-hit-area" />
              {#if block.image}
                <!-- Image block (GIFs excluded) -->
                <defs>
                  <clipPath id="clip-{block.id}">
                    <circle cx="0" cy="0" r="20"/>
                  </clipPath>
                </defs>
                {#if showImageThumbnails}
                  <image 
                    href={block.image}
                    x="-20"
                    y="-20"
                    width="40"
                    height="40"
                    clip-path="url(#clip-{block.id})"
                    class="block-image"
                    preserveAspectRatio="xMidYMid slice"
                    loading="lazy"
                  />
                {:else}
                  <!-- Show colored circle instead of image for performance -->
                  <circle 
                    cx="0" 
                    cy="0" 
                    r="20" 
                    fill="#8ac926"
                    opacity="0.6"
                  />
                {/if}
                {#if isBlockSelected(block)}
                  <circle 
                    cx="0" 
                    cy="0" 
                    r="35" 
                    fill="none"
                    stroke="#ff3e00"
                    stroke-width="3"
                    class="selection-ring"
                  />
                {/if}
              {:else}
                <!-- Text/other block -->
                <circle 
                  cx="0" 
                  cy="0" 
                  r="25" 
                  fill={block.type === 'Text' ? '#ff6b35' : '#fdc82f'}
                  opacity="0.8"
                  class="block-circle"
                />
                <text
                  x="0"
                  y="5"
                  text-anchor="middle"
                  font-size="20"
                  fill="white"
                  class="block-icon"
                >
                  {block.type === 'Text' ? '📝' : '🔗'}
                </text>
                {#if isBlockSelected(block)}
                  <circle 
                    cx="0" 
                    cy="0" 
                    r="30" 
                    fill="none"
                    stroke="#ff3e00"
                    stroke-width="3"
                    class="selection-ring"
                  />
                {/if}
              {/if}
              </g>
            </g>
              {/each}
            </g>
          {/each}
        </svg>

        <!-- Tooltip -->


        <!-- 4 corners: each can show a panel or circle -->
        {#each [0, 1, 2, 3] as i}
          {@const block = selectedBlocks[i]}
          {@const cornerClass = ['corner-tl', 'corner-tr', 'corner-bl', 'corner-br'][i]}
          <div class="detail-panel-anchor {cornerClass}">
            {#if block}
              <div
                class="detail-panel detail-panel-box {cornerClass}"
                class:expanded={panelExpanded[i]}
                bind:this={detailPanelEls[i]}
              >
                <div class="detail-panel-inner">
                  {#if block.image}
                    <a href="https://www.are.na/block/{block.id}" target="_blank" rel="noopener noreferrer" class="detail-image-wrap">
                      <img src={block.image} alt={block.title} class="detail-image" />
                    </a>
                  {/if}
                  <div class="detail-panel-footer">
                    <h3>{block.title || 'Untitled'}</h3>
                    <button type="button" class="close-btn" on:click={() => closePanel(i)}>×</button>
                  </div>
                </div>
              </div>
            {:else}
              <div class="detail-panel-circle {cornerClass}" aria-hidden="true"></div>
            {/if}
          </div>
        {/each}
      </div>

    {/if}
  </div>
</main>

<style>
  :global(html), :global(body) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  :global(body) {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #ffffff;
  }

  main {
    padding: 0;
    margin: 0;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }

  header {
    margin-bottom: 2em;
    max-width: 1200px;
  }

  h1 {
    margin: 0 0 0.5em 0;
    color: #333;
  }

  .subtitle {
    color: #666;
    margin: 0 0 1em 0;
    font-size: 1.1em;
  }

  .border {
    position: absolute;
    top: 2%;
    left: 1%;
    width: 98%;
    height: 96%;
    border: 2px solid #d9d9d9;
    z-index: 1000;
    border-radius: 10px;
    pointer-events: none; /* visible but don't block clicks/hover on blocks */
  }

  .entry-screen {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    box-sizing: border-box;
  }

  .entry-title {
    margin: 0 0 0.25em 0;
    font-size: 1.75rem;
    color: #333;
  }

  .entry-hint {
    margin: 0 0 1.5rem 0;
    color: #666;
    font-size: 0.95rem;
  }

  .entry-form {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    max-width: 420px;
  }

  .entry-input {
    width: 100%;
    padding: 0.65rem 0.9rem;
    font-size: 1rem;
    border: 2px solid #d9d9d9;
    border-radius: 10px;
    box-sizing: border-box;
  }

  .entry-input:focus {
    outline: none;
    border-color: #ff3e00;
  }

  .entry-btn {
    padding: 0.6rem 1.5rem;
    font-size: 1rem;
    font-weight: 600;
    color: white;
    background: #ff3e00;
    border: none;
    border-radius: 10px;
    cursor: pointer;
  }

  .entry-btn:hover {
    background: #e63900;
  }

  .entry-suggestions-label {
    margin: 2rem 0 0.5rem 0;
    color: #666;
    font-size: 0.9rem;
  }

  .entry-suggestions {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .entry-suggestion {
    padding: 0.5rem 1rem;
    font-size: 0.95rem;
    color: #333;
    background: #f5f5f5;
    border: 2px solid #e0e0e0;
    border-radius: 10px;
    cursor: pointer;
  }

  .entry-suggestion:hover {
    border-color: #ff3e00;
    background: #fff5f2;
  }

  .stats {
    display: flex;
    gap: 1em;
    flex-wrap: wrap;
    margin-bottom: 1.5em;
  }

  .stat {
    background: rgb(255, 255, 255);
    padding: 0.5em 1em;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    font-size: 0.95em;
  }

  .info-box {
    padding: 1.5em;
    border-radius: 12px;
    margin: 1.5em 0;
  }

  .info-box h3 {
    margin: 0 0 0.5em 0;
  }

  .success {
    background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
    color: white;
    padding: 1em;
    border-radius: 8px;
  }

  .success .note {
    opacity: 0.9;
    font-size: 0.9em;
    margin-top: 0.5em;
  }

  .note {
    font-size: 0.9em;
    opacity: 0.9;
    margin-top: 1em;
    font-style: italic;
  }

  .progress-bar {
    background: rgba(255, 255, 255, 0.3);
    height: 24px;
    border-radius: 12px;
    overflow: hidden;
    margin: 1em 0 0.5em 0;
  }

  .progress-fill {
    background: white;
    height: 100%;
    transition: width 0.3s ease;
    border-radius: 12px;
  }

  .progress-text {
    font-size: 0.9em;
    margin: 0.5em 0 0 0;
    font-weight: 600;
  }

  .loading {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    z-index: 1000;
  }

  .loading-dots {
    position: relative;
    width: 28px;
    height: 28px;
    margin: 0 auto;
  }

  .loading-dots .dot {
    position: absolute;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #888;
    top: 50%;
    left: 50%;
    animation: dot-circle 1.2s linear infinite;
  }

  .loading-dots .dot:nth-child(1) { animation-delay: 0s; }
  .loading-dots .dot:nth-child(2) { animation-delay: -0.4s; }
  .loading-dots .dot:nth-child(3) { animation-delay: -0.8s; }

  @keyframes dot-circle {
    0% {
      transform: translate(-50%, -50%) rotate(0deg) translateY(-10px) rotate(0deg);
    }
    100% {
      transform: translate(-50%, -50%) rotate(360deg) translateY(-10px) rotate(-360deg);
    }
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }

  .error {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #ffe0e0;
    color: #cc0000;
    padding: 2em;
    border-radius: 8px;
    text-align: center;
    z-index: 1000;
  }

  .error p { margin: 0 0 1em 0; }
  .error .entry-btn { margin-top: 0.5em; }

  .canvas-container {
    background: #ffffff;
    padding: 0;
    overflow: hidden;
    position: relative;
    width: 100vw;
    height: 100vh;
  }

  .controls {
    position: absolute;
    top: 20px;
    right: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    z-index: 10;
  }

  .control-btn {
    width: 45px;
    height: 45px;
    border-radius: 8px;
    background: white;
    border: 2px solid #e0e0e0;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    font-weight: bold;
    color: #333;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    transition: all 0.2s;
  }

  .control-btn:hover {
    background: #f5f5f5;
    border-color: #ff3e00;
    transform: scale(1.05);
  }

  .control-btn:active {
    transform: scale(0.95);
  }

  .control-hint {
    background: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 0.5em 1em;
    border-radius: 6px;
    font-size: 0.8em;
    text-align: center;
    margin-top: 5px;
    white-space: nowrap;
  }

  .cluster-canvas {
    display: block;
    width: 100%;
    height: 100%;
    cursor: grab;
    /* Performance optimizations */
    will-change: transform;
    transform: translateZ(0);
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
  }

  .cluster-canvas.panning {
    cursor: grabbing;
  }

  .block-hit-area {
    cursor: pointer;
    pointer-events: auto;
  }

  .block-node {
    cursor: pointer;
    transition: opacity 0.2s, filter 0.3s ease-out;
  }

  .block-node:hover {
    filter: brightness(1.1);
  }

  .block-node.hovered {
    filter: brightness(1.15) drop-shadow(0 4px 12px rgba(0, 0, 0, 0.4));
  }

  .block-content {
    transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    transform-origin: center center;
    transform: translate(0, 0) scale(1);
  }

  /* Hover transform (direction away from cluster) is set per-block via inline style */

  .block-node.selected {
    filter: drop-shadow(0 0 10px rgba(255, 62, 0, 0.8));
  }

  .block-image {
    pointer-events: none;
    image-rendering: -webkit-optimize-contrast;
    image-rendering: crisp-edges;
    will-change: transform;
    transform: translateZ(0); /* Force GPU acceleration */
  }

  .block-circle {
    transition: all 0.2s;
  }

  .block-node:hover .block-circle {
    stroke: #fff;
    stroke-width: 2;
  }

  .block-icon {
    pointer-events: none;
    user-select: none;
  }


  .selection-ring {
    animation: pulse-ring 1.5s ease-in-out infinite;
  }

  @keyframes pulse-ring {
    0%, 100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.5;
      transform: scale(1.1);
    }
  }

  .tooltip {
    position: absolute;
    top: 20px;
    left: 20px;
    background: rgba(0, 0, 0, 0.9);
    color: white;
    padding: 1em;
    border-radius: 8px;
    max-width: 300px;
    pointer-events: none;
    z-index: 1000;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .tooltip strong {
    display: block;
    margin-bottom: 0.5em;
    font-size: 1.1em;
  }

  .tooltip-type {
    display: inline-block;
    background: rgba(255, 255, 255, 0.2);
    padding: 0.2em 0.5em;
    border-radius: 4px;
    font-size: 0.8em;
    margin-bottom: 0.5em;
  }

  .tooltip p {
    margin: 0.5em 0 0 0;
    font-size: 0.9em;
    opacity: 0.9;
  }

  .detail-panel {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: white;
    padding: 1.5em;
    overflow-y: auto;
    z-index: 1001;
  }

  /* Anchor: same top-left for circle and panel */
  .detail-panel-anchor {
    position: absolute;
    z-index: 1001;
  }
  .detail-panel-anchor.corner-tl { top: 4%; left: 2%; }
  .detail-panel-anchor.corner-tr { top: 4%; right: 2%; }
  .detail-panel-anchor.corner-bl { bottom: 4%; left: 2%; }
  .detail-panel-anchor.corner-br { bottom: 4%; right: 2%; }

  /* Circle: same size in each corner, position by corner */
  .detail-panel-circle {
    position: absolute;
    width: 20px;
    height: 20px;
    border: 2px solid #d9d9d9;
    border-radius: 10px;
    background: transparent;
    box-sizing: border-box;
  }
  .detail-panel-circle.corner-tl { top: 0; left: 0; }
  .detail-panel-circle.corner-tr { top: 0; right: 0; }
  .detail-panel-circle.corner-bl { bottom: 0; left: 0; }
  .detail-panel-circle.corner-br { bottom: 0; right: 0; }

  /* Panel: starts 20px, expands; position and growth depend on corner */
  .detail-panel.detail-panel-box {
    position: absolute;
    width: 20px;
    height: 20px;
    min-width: 20px;
    min-height: 20px;
    padding: 0;
    border: 2px solid #d9d9d9;
    border-radius: 10px;
    overflow: hidden;
    transition: width 0.3s ease-out, height 0.35s ease-out, border-radius 0.3s ease-out;
    box-sizing: border-box;
  }
  .detail-panel.detail-panel-box.corner-tl { top: 0; left: 0; right: auto; bottom: auto; }
  .detail-panel.detail-panel-box.corner-tr { top: 0; right: 0; left: auto; bottom: auto; }
  .detail-panel.detail-panel-box.corner-bl { bottom: 0; left: 0; top: auto; right: auto; }
  .detail-panel.detail-panel-box.corner-br { bottom: 0; right: 0; top: auto; left: auto; }

  .detail-panel.detail-panel-box.expanded {
    width: 360px;
    height: 40vh;
    max-width: calc(100vw - 6%);
    border-radius: 10px;
    overflow-y: auto;
  }

  /* Fixed-size content: never moves or reflows; panel expansion just reveals it */
  .detail-panel-inner {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 360px;
    min-height: 100%;
    padding: 1.5em;
    box-sizing: border-box;
  }

  .detail-panel-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75em;
    margin-top: auto;
    padding-top: 1em;
  }


  @keyframes slideUp {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
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

  .detail-type {
    display: inline-block;
    background: #f0f0f0;
    padding: 0.3em 0.6em;
    border-radius: 4px;
    font-size: 0.85em;
    color: #666;
    margin-bottom: 1em;
  }

  .detail-description {
    color: #666;
    line-height: 1.6;
    margin: 1em 0;
  }

  .detail-content {
    color: #666;
    line-height: 1.6;
    margin: 1em 0;
    font-size: 0.95em;
    max-height: 150px;
    overflow-y: auto;
  }

  .detail-link {
    display: inline-block;
    margin-top: 1em;
    padding: 0.5em 1em;
    background: #ff3e00;
    color: white;
    text-decoration: none;
    border-radius: 6px;
    font-size: 0.9em;
    transition: background 0.2s;
  }

  .detail-link:hover {
    background: #e63900;
  }

  .detail-link-secondary {
    margin-left: 0;
    margin-top: 0.5em;
  }

  .legend {
    background: white;
    padding: 1.5em;
    border-radius: 12px;
    margin-top: 2em;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .legend h3 {
    margin: 0 0 1em 0;
    color: #333;
    font-size: 1.2em;
  }

  .legend-items {
    display: flex;
    flex-direction: column;
    gap: 0.6em;
    margin-bottom: 1em;
  }

  .legend-item {
    color: #666;
    font-size: 0.95em;
  }

  .legend-item strong {
    color: #333;
  }

  .legend-colors {
    display: flex;
    gap: 0.8em;
    flex-wrap: wrap;
    margin: 1em 0;
  }

  .color-badge {
    padding: 0.4em 0.8em;
    border-radius: 6px;
    font-size: 0.85em;
    font-weight: 500;
  }

  .image-badge {
    background: rgba(138, 201, 38, 0.2);
    color: #5a8a1f;
  }

  .text-badge {
    background: rgba(255, 107, 53, 0.2);
    color: #cc4422;
  }

  .link-badge {
    background: rgba(253, 200, 47, 0.2);
    color: #b8891f;
  }

  .legend-note {
    margin-top: 1em;
    font-size: 0.9em;
    color: #666;
    padding: 0.8em;
    background: #f9f9f9;
    border-radius: 6px;
    border-left: 3px solid #ff3e00;
  }
</style>
