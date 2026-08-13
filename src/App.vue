<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import { renderPdfToImage } from './lib/pdf.js';
import { resumeAudio, playDrumHit } from './lib/drumSound.js';

const DATA_PREFIX = 'drumScore:data:';
const INDEX_KEY = 'drumScore:index';

// 文件 / 画面
const fileName = ref('');
const imgUrl = ref('');
const loading = ref(false);
const surface = ref(null); // 相对定位的图层容器
const surfaceWrap = ref(null); // 滚动容器
const cursorEl = ref(null);

// 标注
const annotationMode = ref(false);
// rows[r] = 第 r+1 行的音标点数组 [{x,y}]（x,y 为 0~1 相对坐标）
const rows = ref([]);
const currentRow = ref(0);

// 播放
const bpm = ref(120);
const soundOn = ref(true);
const isPlaying = ref(false);
const litIndex = ref(-1); // 当前高亮的音标（flatNotes 下标）
const flatIndex = ref(0); // 下一个待播放
let timer = null;

// 保存
const saveName = ref('');
const savedNames = ref([]);
const selectedSaved = ref('');
const importInput = ref(null);

// 轻提示（3 秒自动消失，不阻塞）
const toastText = ref('');
let toastTimer = null;
function toast(msg) {
  toastText.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastText.value = ''), 3000);
}

const flatNotes = computed(() => {
  const out = [];
  rows.value.forEach((row) => {
    row.forEach((n) => out.push({ x: n.x, y: n.y }));
  });
  return out;
});

const markers = computed(() => {
  const out = [];
  rows.value.forEach((row, ri) => {
    row.forEach((n, si) => {
      out.push({ ri, si, x: n.x, y: n.y, row: ri + 1, seq: si + 1 });
    });
  });
  return out;
});

const rowHeaders = computed(() => {
  const out = [];
  rows.value.forEach((row, ri) => {
    if (row.length) out.push({ row: ri + 1, x: row[0].x, y: row[0].y });
  });
  return out;
});

const cursorNote = computed(() => {
  const i = litIndex.value;
  if (i >= 0 && i < flatNotes.value.length) return flatNotes.value[i];
  return null;
});

const totalNotes = computed(() => flatNotes.value.length);

function intervalMs() {
  return 60000 / Math.max(1, bpm.value);
}

// ---------- 文件加载 ----------
async function onFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  stop();
  annotationMode.value = false;
  loading.value = true;
  fileName.value = file.name;
  try {
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      const buf = await file.arrayBuffer();
      const res = await renderPdfToImage(buf, 2);
      imgUrl.value = res.dataUrl;
    } else {
      imgUrl.value = URL.createObjectURL(file);
    }
    // 新文件默认不加载旧标注
    rows.value = [];
    currentRow.value = 0;
    saveName.value = file.name.replace(/\.[^.]+$/, '');
    refreshSavedList();
  } catch (err) {
    console.error(err);
    toast('文件加载失败：' + err.message);
  } finally {
    loading.value = false;
    e.target.value = '';
  }
}

// ---------- 标注 ----------
function toggleAnnotation() {
  if (!imgUrl.value) {
    toast('请先上传鼓谱文件');
    return;
  }
  annotationMode.value = !annotationMode.value;
  if (annotationMode.value) {
    stop();
    if (!rows.value.length) {
      rows.value = [[]];
      currentRow.value = 0;
    } else {
      currentRow.value = rows.value.length - 1;
      if (!rows.value[currentRow.value]) rows.value[currentRow.value] = [];
    }
  }
}

function onSurfaceClick(e) {
  if (!annotationMode.value || isPlaying.value) return;
  const el = surface.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  if (!rows.value[currentRow.value]) rows.value[currentRow.value] = [];
  rows.value[currentRow.value].push({ x, y });
}

function newRow() {
  if (!annotationMode.value) return;
  rows.value.push([]);
  currentRow.value = rows.value.length - 1;
}

function undoPoint() {
  if (!annotationMode.value) return;
  const row = rows.value[currentRow.value];
  if (row && row.length) {
    row.pop();
  } else if (currentRow.value > 0) {
    rows.value.pop();
    currentRow.value = rows.value.length - 1;
  }
}

function clearAnnotations() {
  if (!confirm('确定清空全部标注吗？')) return;
  rows.value = [[]];
  currentRow.value = 0;
  stop();
}

const currentRowCount = computed(
  () => (rows.value[currentRow.value] || []).length
);

// ---------- 保存 / 读取 ----------
function buildData() {
  return { v: 1, name: saveName.value, bpm: bpm.value, rows: rows.value };
}

function refreshSavedList() {
  try {
    const arr = JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
    savedNames.value = arr;
    if (!selectedSaved.value && arr.length) selectedSaved.value = arr[0];
  } catch {
    savedNames.value = [];
  }
}

function saveAnnotations() {
  const name = (saveName.value || '').trim() || (fileName.value || '未命名');
  saveName.value = name;
  localStorage.setItem(DATA_PREFIX + name, JSON.stringify(buildData()));
  const set = new Set(savedNames.value);
  set.add(name);
  savedNames.value = [...set];
  localStorage.setItem(INDEX_KEY, JSON.stringify(savedNames.value));
  selectedSaved.value = name;
  toast('已保存：' + name);
}

function loadAnnotations() {
  const name = selectedSaved.value;
  if (!name) {
    toast('没有可读取的标注');
    return;
  }
  const raw = localStorage.getItem(DATA_PREFIX + name);
  if (!raw) {
    toast('未找到该标注');
    return;
  }
  applyData(JSON.parse(raw));
  toast('已读取：' + name);
}

function deleteSaved() {
  const name = selectedSaved.value;
  if (!name) return;
  if (!confirm('删除保存的标注「' + name + '」？')) return;
  localStorage.removeItem(DATA_PREFIX + name);
  savedNames.value = savedNames.value.filter((n) => n !== name);
  localStorage.setItem(INDEX_KEY, JSON.stringify(savedNames.value));
  if (savedNames.value.length) selectedSaved.value = savedNames.value[0];
}

function applyData(data) {
  stop();
  rows.value = Array.isArray(data.rows) ? data.rows.map((r) => r.map((n) => ({ x: n.x, y: n.y }))) : [];
  if (!rows.value.length) rows.value = [[]];
  currentRow.value = rows.value.length - 1;
  if (typeof data.bpm === 'number') bpm.value = data.bpm;
  if (typeof data.name === 'string') saveName.value = data.name;
}

function exportJson() {
  if (!rows.value.length) {
    toast('暂无标注可导出');
    return;
  }
  const blob = new Blob([JSON.stringify(buildData(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (saveName.value || 'drum-score') + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function onImportClick() {
  importInput.value && importInput.value.click();
}

function onImportChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyData(JSON.parse(reader.result));
      toast('已导入标注');
    } catch (err) {
      toast('导入失败：' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ---------- 播放 ----------
function tick() {
  if (!isPlaying.value) return;
  const notes = flatNotes.value;
  if (flatIndex.value >= notes.length) {
    isPlaying.value = false;
    return;
  }
  litIndex.value = flatIndex.value;
  if (soundOn.value) playDrumHit();
  flatIndex.value++;
  timer = setTimeout(tick, intervalMs());
}

function play() {
  if (!flatNotes.value.length) {
    toast('请先标注音标');
    return;
  }
  if (annotationMode.value) annotationMode.value = false;
  resumeAudio();
  if (flatIndex.value >= flatNotes.value.length) flatIndex.value = 0;
  isPlaying.value = true;
  tick();
}

function pause() {
  isPlaying.value = false;
  clearTimeout(timer);
}

function stop() {
  isPlaying.value = false;
  clearTimeout(timer);
  flatIndex.value = 0;
  litIndex.value = -1;
}

// 播放时自动滚动跟随光标
watch(litIndex, () => {
  if (!isPlaying.value) return;
  nextTick(() => {
    const cur = cursorEl.value;
    const wrap = surfaceWrap.value;
    if (!cur || !wrap) return;
    const cr = cur.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    if (cr.bottom > wr.bottom - 24) {
      wrap.scrollTop += cr.bottom - wr.bottom + 48;
    } else if (cr.top < wr.top + 24) {
      wrap.scrollTop -= wr.top - cr.top + 48;
    }
  });
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  clearTimeout(toastTimer);
});

refreshSavedList();
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">🥁 鼓谱标注播放器</div>
      <label class="file-btn">
        上传鼓谱
        <input type="file" accept="image/*,application/pdf" @change="onFileChange" hidden />
      </label>
      <span class="filename" :title="fileName">{{ fileName || '未加载文件' }}</span>
    </header>

    <div class="toolbar">
      <button class="btn" :class="{ active: annotationMode }" @click="toggleAnnotation">
        {{ annotationMode ? '退出标注' : '手动标注' }}
      </button>
      <button class="btn" :disabled="!annotationMode" @click="newRow">下一行</button>
      <button class="btn" :disabled="!annotationMode" @click="undoPoint">撤销</button>
      <button class="btn danger" @click="clearAnnotations">清空标注</button>

      <span class="sep"></span>

      <button class="btn" @click="saveAnnotations">保存标注</button>
      <select v-model="selectedSaved" class="sel">
        <option v-for="n in savedNames" :key="n" :value="n">{{ n }}</option>
      </select>
      <button class="btn" @click="loadAnnotations">读取</button>
      <button class="btn" @click="deleteSaved">删除</button>
      <button class="btn" @click="exportJson">导出JSON</button>
      <button class="btn" @click="onImportClick">导入JSON</button>
      <input ref="importInput" type="file" accept="application/json" hidden @change="onImportChange" />

      <span class="sep"></span>

      <label class="field">速度 BPM
        <input type="number" class="num" min="20" max="400" v-model.number="bpm" />
      </label>
      <label class="field check">
        <input type="checkbox" v-model="soundOn" /> 鼓声
      </label>

      <span class="sep"></span>

      <button v-if="!isPlaying" class="btn primary" @click="play">▶ 播放</button>
      <button v-else class="btn warn" @click="pause">⏸ 暂停</button>
      <button class="btn" @click="stop">⏹ 停止</button>
    </div>

    <div class="status">
      <template v-if="annotationMode">
        正在标注第 <b>{{ currentRow + 1 }}</b> 行，已标 <b>{{ currentRowCount }}</b> 个音标。点击画面添加音标，完成后点「下一行」。
      </template>
      <template v-else>
        共 <b>{{ rows.filter(r => r.length).length }}</b> 行，<b>{{ totalNotes }}</b> 个音标。
        <template v-if="isPlaying">播放中…</template>
      </template>
    </div>

    <div class="surface-wrap" ref="surfaceWrap">
      <div v-if="loading" class="loading">正在加载文件…</div>
      <div v-if="imgUrl" class="surface" ref="surface" @click="onSurfaceClick"
           :class="{ crosshair: annotationMode && !isPlaying }">
        <img :src="imgUrl" class="score-img" alt="鼓谱" />

        <!-- 行号标签 + 音标点：仅在标注模式下显示，退出后隐藏，保持谱面干净 -->
        <template v-if="annotationMode">
          <div v-for="h in rowHeaders" :key="'h' + h.row" class="row-header"
               :style="{ left: h.x * 100 + '%', top: h.y * 100 + '%' }">
            第{{ h.row }}行
          </div>

          <div v-for="m in markers" :key="m.ri + '-' + m.si" class="marker"
               :style="{ left: m.x * 100 + '%', top: m.y * 100 + '%' }">
            <span class="seq">{{ m.seq }}</span>
          </div>
        </template>

        <!-- 播放光标 -->
        <div v-if="cursorNote" class="cursor" ref="cursorEl"
             :style="{ left: cursorNote.x * 100 + '%', top: cursorNote.y * 100 + '%' }"></div>
      </div>
      <div v-else-if="!loading" class="empty">
        <p>请点击上方「上传鼓谱」按钮，选择图片或 PDF 文件。</p>
        <p class="hint">上传后点「手动标注」，依次点击每个音标位置；一行标完点「下一行」。标注可保存，之后用于按速度播放。</p>
      </div>
    </div>

    <transition name="toast-fade">
      <div v-if="toastText" class="toast">{{ toastText }}</div>
    </transition>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f4f5f7;
  color: #1f2329;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: #1f2329;
  color: #fff;
}
.brand { font-weight: 700; font-size: 16px; }
.file-btn {
  cursor: pointer;
  padding: 6px 14px;
  background: #2563eb;
  color: #fff;
  border-radius: 6px;
  font-size: 13px;
}
.file-btn:hover { background: #1d4ed8; }
.filename {
  font-size: 13px;
  color: #c7c9d1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40vw;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: #fff;
  border-bottom: 1px solid #e5e6eb;
}
.btn {
  padding: 6px 12px;
  border: 1px solid #d0d3d9;
  background: #fff;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: #1f2329;
}
.btn:hover:not(:disabled) { background: #f2f3f5; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn.active { background: #2563eb; color: #fff; border-color: #2563eb; }
.btn.primary { background: #16a34a; color: #fff; border-color: #16a34a; }
.btn.warn { background: #f59e0b; color: #fff; border-color: #f59e0b; }
.btn.danger { color: #dc2626; border-color: #f3b0b0; }
.sep { width: 1px; height: 22px; background: #e5e6eb; margin: 0 4px; }
.sel { padding: 5px 8px; border: 1px solid #d0d3d9; border-radius: 6px; font-size: 13px; max-width: 160px; }
.field { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.num { width: 64px; padding: 5px 6px; border: 1px solid #d0d3d9; border-radius: 6px; }
.check { cursor: pointer; }
.status {
  padding: 6px 16px;
  font-size: 13px;
  color: #4e5969;
  background: #fafafa;
  border-bottom: 1px solid #e5e6eb;
}
.status b { color: #1f2329; }

.surface-wrap {
  flex: 1;
  overflow: auto;
  position: relative;
  padding: 16px;
}
.surface {
  position: relative;
  display: inline-block;
  max-width: 100%;
}
.score-img { display: block; max-width: 100%; user-select: none; }
.surface.crosshair { cursor: crosshair; }
.loading, .empty {
  text-align: center;
  color: #86909c;
  padding: 60px 20px;
}
.empty .hint { font-size: 13px; max-width: 560px; margin: 12px auto; line-height: 1.6; }

.marker {
  position: absolute;
  width: 24px;
  height: 24px;
  margin: -12px 0 0 -12px;
  border-radius: 50%;
  background: #2563eb;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px #2563eb;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.seq {
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}
.row-header {
  position: absolute;
  transform: translate(14px, -34px);
  background: #dc2626;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
  pointer-events: none;
}
.cursor {
  position: absolute;
  width: 44px;
  height: 44px;
  margin: -22px 0 0 -22px;
  border-radius: 8px;
  background: rgba(250, 204, 21, 0.35);
  border: 3px solid #f59e0b;
  box-shadow: 0 0 12px rgba(245, 158, 11, 0.8);
  pointer-events: none;
}

.toast {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  background: #1f2329;
  color: #fff;
  padding: 10px 18px;
  border-radius: 8px;
  font-size: 13px;
  z-index: 9999;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  pointer-events: none;
}
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.25s ease;
}
.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
}
</style>
