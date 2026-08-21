// 自动预标注：对白底黑字鼓谱做「谱行 + 音符头」检测，生成可微调的预标注。
// 纯前端像素分析（不依赖模型）：
//   1. 图片降采样 → 灰度 → Otsu 自适应二值化
//   2. 连通域分析 → 形状过滤（实心、近椭圆、尺寸自适应）得到音符头
//   3. 音符头按垂直位置聚类成行，生成与手动标注同结构的 rows
// 输出与手动标注完全兼容：[{ top, height, notes: [{x}] }]（相对坐标 0~1）

const MAX_WIDTH = 1400; // 分析用的最大宽度（提速，精度足够）

// 加载 Blob 并取出（可能缩放后的）ImageData
async function getImageData(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_WIDTH / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  bmp.close();
  return { rgba: data.data, width: w, height: h };
}

// Otsu 大津法：从灰度直方图找最优二值化阈值（对白底黑字印刷谱最稳）
function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

// 二值化：黑（音符）= true
function binarize(rgba) {
  const n = rgba.length / 4;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    // 透明区按白底处理（PNG 谱面常见）
    const alpha = a / 255;
    gray[i] = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * alpha + 255 * (1 - alpha));
  }
  const thr = otsuThreshold(gray);
  const bin = new Uint8Array(n); // 1 = 黑
  for (let i = 0; i < n; i++) bin[i] = gray[i] < thr ? 1 : 0;
  return bin;
}

// 连通域（4 邻接，栈式 flood fill），返回每个黑块的统计信息
function connectedComponents(bin, width, height) {
  const labels = new Int32Array(bin.length); // 0 = 未访问
  const blobs = [];
  const stack = new Int32Array(bin.length);
  let nextLabel = 1;
  for (let start = 0; start < bin.length; start++) {
    if (!bin[start] || labels[start]) continue;
    const label = nextLabel++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % width;
      const py = (p - px) / width;
      area++;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      // 上下左右
      if (px > 0) {
        const q = p - 1;
        if (bin[q] && !labels[q]) { labels[q] = label; stack[sp++] = q; }
      }
      if (px < width - 1) {
        const q = p + 1;
        if (bin[q] && !labels[q]) { labels[q] = label; stack[sp++] = q; }
      }
      if (py > 0) {
        const q = p - width;
        if (bin[q] && !labels[q]) { labels[q] = label; stack[sp++] = q; }
      }
      if (py < height - 1) {
        const q = p + width;
        if (bin[q] && !labels[q]) { labels[q] = label; stack[sp++] = q; }
      }
    }
    blobs.push({
      minX, minY, maxX, maxY, area,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
    });
  }
  return blobs;
}

// 音符头过滤：实心（填充率高）、近椭圆（宽高比合理）、尺寸取“数量最多的那类小块”
function filterNoteHeads(blobs, width, height) {
  if (!blobs.length) return [];
  // 音符头是谱面上数量最多的实心小黑块：按高度直方图找众数
  const hist = new Map();
  for (const b of blobs) {
    const k = Math.round(b.h);
    if (k > 0) hist.set(k, (hist.get(k) || 0) + 1);
  }
  let modeH = 0;
  let modeCount = 0;
  for (const [k, c] of hist) {
    if (c > modeCount || (c === modeCount && k > modeH)) {
      modeH = k;
      modeCount = c;
    }
  }
  if (!modeH) return [];
  const minH = modeH * 0.55;
  const maxH = modeH * 1.9;
  const heads = [];
  for (const b of blobs) {
    if (b.h < minH || b.h > maxH) continue;             // 尺寸不在音符头范围
    if (b.w > width * 0.03 || b.h > height * 0.03) continue; // 排除长线/大块
    const ar = b.w / b.h;
    if (ar < 0.5 || ar > 2.6) continue;                  // 排除细竖干（符干）等
    const fill = b.area / (b.w * b.h);
    if (fill < 0.5) continue;                            // 空心/斜纹块（休止符等）不要
    heads.push(b);
  }
  return heads;
}

// 音符头按垂直位置聚成谱行；返回与手动标注同结构的 rows（相对坐标）
function clusterRows(heads, width, height) {
  if (heads.length < 4) return []; // 太少认为不是有效谱面
  const sorted = [...heads].sort((a, b) => a.cy - b.cy);
  const hs = sorted.map((b) => b.h).sort((a, b) => a - b);
  const medH = hs[Math.floor(hs.length / 2)];
  const gap = medH * 2.4; // 相邻音符中心差超过该值视为跨行
  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].cy - sorted[i - 1].cy > gap) {
      groups.push(cur);
      cur = [sorted[i]];
    } else {
      cur.push(sorted[i]);
    }
  }
  groups.push(cur);

  const rows = [];
  const bandH = Math.min(0.2, (medH * 3.4) / height); // 行带比音符略高，与手动行高一致量级
  for (const g of groups) {
    if (g.length < 2) continue; // 单个孤立块（力度记号等）不成行
    const notes = g
      .map((b) => ({ x: b.cx / width }))
      .sort((a, b) => a.x - b.x)
      .filter((n, i, arr) => i === 0 || n.x - arr[i - 1].x > 0.004); // 去重贴点
    if (notes.length < 2) continue;
    const cys = g.map((b) => b.cy);
    const top = Math.min(...cys) / height - bandH * 0.18;
    rows.push({
      top: Math.max(0, top),
      height: bandH,
      notes,
    });
  }
  // 防行带重叠：顺次压顶
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    if (rows[i].top < prev.top + prev.height) {
      rows[i].top = Math.min(1 - bandH, prev.top + prev.height);
    }
  }
  return rows;
}

// 主入口：分析谱面图片，返回预标注 rows；失败抛错（信息面向用户）
export async function detectScore(blob) {
  const { rgba, width, height } = await getImageData(blob);
  const bin = binarize(rgba);
  const blobs = connectedComponents(bin, width, height);
  const heads = filterNoteHeads(blobs, width, height);
  const rows = clusterRows(heads, width, height);
  const noteCount = rows.reduce((s, r) => s + r.notes.length, 0);
  if (!rows.length || noteCount < 4) {
    throw new Error('未能识别出音符，请检查图片是否清晰，或改用手动标注');
  }
  return rows;
}
