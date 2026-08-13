import * as pdfjsLib from 'pdfjs-dist';
// 通过 Vite 的 ?url 导入 worker 地址
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// 将 PDF（ArrayBuffer）渲染为单张图片 dataURL（多页纵向拼接）
// 返回 { dataUrl, width, height }
export async function renderPdfToImage(arrayBuffer, scale = 2) {
  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    // CJK 字符所需 cMap（已复制到 public/cmaps，由 Vite 静态托管在 /cmaps/）
    cMapUrl: './cmaps/',
    cMapPacked: true,
  });
  const pdf = await loadingTask.promise;

  const pages = [];
  let maxWidth = 0;
  let totalHeight = 0;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    pages.push(canvas);
    if (canvas.width > maxWidth) maxWidth = canvas.width;
    totalHeight += canvas.height;
  }

  const out = document.createElement('canvas');
  out.width = maxWidth;
  out.height = totalHeight;
  const octx = out.getContext('2d');
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, out.width, out.height);
  let y = 0;
  for (const c of pages) {
    octx.drawImage(c, 0, y);
    y += c.height;
  }

  return {
    dataUrl: out.toDataURL('image/png'),
    width: out.width,
    height: out.height,
  };
}
