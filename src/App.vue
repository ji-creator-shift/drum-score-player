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
const markMode = ref('rows'); // 'rows' 标行 | 'notes' 标序号
const rowHeightPct = ref(4); // 行光带高度（谱面高度百分比，可调）
const hoverY = ref(-1); // 标行模式下鼠标的相对 y（预览光带位置）
// rows[r] = 第 r+1 行：{ top, height, notes: [{x}] }（均为 0~1 相对坐标）
const rows = ref([]);
let undoStack = []; // 撤销栈（存对象引用，不受行/序号重排影响）

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

// 背景音乐 / 延时
const musicName = ref('');
const musicUrl = ref('');
const audioEl = ref(null);
const musicVolume = ref(0.8);   // 音乐音量 0~1
const musicDelay = ref(2);      // 延时秒数：点击播放后先放音乐，倒计时结束再开始显示标注
const countIn = ref(false);     // 延时期间按 BPM 打点（预备拍）
const delayRemain = ref(0);     // 剩余延时（毫秒），>0 表示处于延时阶段
let delayTimer = null;
let nextBeatAt = 0;

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
  rows.value.forEach((row, ri) => {
    row.notes.forEach((n) => out.push({ x: n.x, ri }));
  });
  return out;
});

const markers = computed(() => {
  const out = [];
  rows.value.forEach((row, ri) => {
    const cy = row.top + row.height / 2;
    row.notes.forEach((n, si) => {
      out.push({ ri, si, x: n.x, y: cy, row: ri + 1, seq: si + 1 });
    });
  });
  return out;
});

// 已固定的行光带（仅标注模式显示）
const rowBands = computed(() =>
  rows.value.map((row, ri) => ({ row: ri + 1, top: row.top, height: row.height }))
);

// 标行模式的预览光带（跟随鼠标）
const previewBand = computed(() => {
  if (markMode.value !== 'rows' || hoverY.value < 0) return null;
  return bandAt(hoverY.value);
});

const cursorNote = computed(() => {
  const i = litIndex.value;
  if (i < 0 || i >= flatNotes.value.length) return null;
  const fn = flatNotes.value[i];
  const row = rows.value[fn.ri];
  if (!row) return null;
  return { x: fn.x, top: row.top, height: row.height };
});

const totalNotes = computed(() => flatNotes.value.length);

function intervalMs() {
  return 60000 / Math.max(1, bpm.value);
}

// 由中心 y 计算行光带位置（相对坐标，自动钳制在谱面内）
function bandAt(y) {
  const h = Math.min(Math.max(Number(rowHeightPct.value) || 4, 1), 20) / 100;
  let top = y - h / 2;
  if (top < 0) top = 0;
  if (top + h > 1) top = 1 - h;
  return { top, height: h };
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
    undoStack = [];
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
    // 已有行则直接进入标序号，否则从标行开始
    markMode.value = rows.value.length ? 'notes' : 'rows';
    undoStack = [];
  }
}

function setMarkMode(m) {
  if (m === 'notes' && !rows.value.length) {
    toast('请先标注行光带');
    return;
  }
  markMode.value = m;
}

function onSurfaceMove(e) {
  if (markMode.value !== 'rows') return;
  const el = surface.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  hoverY.value = (e.clientY - r.top) / r.height;
}

function onSurfaceLeave() {
  hoverY.value = -1;
}

function onSurfaceClick(e) {
  if (!annotationMode.value || isPlaying.value) return;
  const el = surface.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;

  if (markMode.value === 'rows') {
    // 点击固定一条行光带，按位置自上而下自动编号
    const row = { ...bandAt(y), notes: [] };
    rows.value.push(row);
    rows.value.sort((a, b) => a.top - b.top);
    undoStack.push({ type: 'row', row });
  } else {
    // 序号归属点击位置所在的行，行内按位置自动编号
    const row = rows.value.find((rw) => y >= rw.top && y <= rw.top + rw.height);
    if (!row) {
      toast('请点击行光带范围内添加序号');
      return;
    }
    const note = { x };
    row.notes.push(note);
    row.notes.sort((a, b) => a.x - b.x);
    undoStack.push({ type: 'note', row, note });
  }
}

function undoPoint() {
  if (!annotationMode.value) return;
  const last = undoStack.pop();
  if (!last) return;
  if (last.type === 'row') {
    rows.value = rows.value.filter((r) => r !== last.row);
  } else {
    last.row.notes = last.row.notes.filter((n) => n !== last.note);
  }
}

function clearAnnotations() {
  if (!confirm('确定清空全部标注吗？')) return;
  rows.value = [];
  undoStack = [];
  markMode.value = 'rows';
  stop();
}

// ---------- 保存 / 读取 ----------
// 兼容 v1（[[{x,y}]] 点数组）与 v2（[{top,height,notes}] 行光带）两种格式
function normalizeRows(raw) {
  if (!Array.isArray(raw)) return [];
  if (raw.length && typeof raw[0] === 'object' && !Array.isArray(raw[0]) && 'top' in raw[0]) {
    return raw.map((r) => ({
      top: r.top,
      height: r.height,
      notes: Array.isArray(r.notes) ? r.notes.map((n) => ({ x: n.x })) : [],
    }));
  }
  // v1 旧格式：按每行音标点的 y 范围估算行光带
  return raw
    .filter((r) => Array.isArray(r) && r.length)
    .map((r) => {
      const ys = r.map((n) => n.y);
      const top = Math.max(0, Math.min(...ys) - 0.025);
      const bottom = Math.min(1, Math.max(...ys) + 0.025);
      return {
        top,
        height: Math.max(0.03, bottom - top),
        notes: r.map((n) => ({ x: n.x })).sort((a, b) => a.x - b.x),
      };
    });
}

function buildData() {
  return {
    v: 2,
    name: saveName.value,
    bpm: bpm.value,
    musicDelay: clampDelay(),
    musicVolume: musicVolume.value,
    countIn: countIn.value,
    rows: rows.value,
  };
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
  rows.value = normalizeRows(data.rows);
  undoStack = [];
  if (typeof data.bpm === 'number') bpm.value = data.bpm;
  if (typeof data.musicDelay === 'number') musicDelay.value = data.musicDelay;
  if (typeof data.musicVolume === 'number') musicVolume.value = data.musicVolume;
  if (typeof data.countIn === 'boolean') countIn.value = data.countIn;
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

// ---------- 背景音乐 ----------
function onMusicChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  stop();
  if (musicUrl.value) URL.revokeObjectURL(musicUrl.value);
  musicUrl.value = URL.createObjectURL(file);
  musicName.value = file.name;
  e.target.value = '';
}

function removeMusic() {
  stop();
  if (musicUrl.value) URL.revokeObjectURL(musicUrl.value);
  musicUrl.value = '';
  musicName.value = '';
}

function clampDelay() {
  const v = Number(musicDelay.value);
  musicDelay.value = Math.min(60, Math.max(0, isNaN(v) ? 0 : v));
  return musicDelay.value;
}

// 延时阶段：倒计时 + 可选预备拍，结束后进入标注播放
function runDelay(ms) {
  const startAt = performance.now();
  const endAt = startAt + ms;
  nextBeatAt = startAt;
  delayRemain.value = ms;
  delayTimer = setInterval(() => {
    const now = performance.now();
    if (countIn.value && soundOn.value) {
      while (nextBeatAt <= now && nextBeatAt < endAt) {
        playDrumHit();
        nextBeatAt += intervalMs();
      }
    }
    if (now >= endAt) {
      clearInterval(delayTimer);
      delayTimer = null;
      delayRemain.value = 0;
      if (isPlaying.value) tick();
    } else {
      delayRemain.value = endAt - now;
    }
  }, 25);
}

// ---------- 播放 ----------
function tick() {
  if (!isPlaying.value) return;
  const notes = flatNotes.value;
  if (flatIndex.value >= notes.length) {
    // 标注播放完毕，连同背景音乐一起停止
    stop();
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
  if (flatIndex.value >= flatNotes.value.length) {
    flatIndex.value = 0;
    litIndex.value = -1;
  }
  isPlaying.value = true;

  // 背景音乐：从当前进度继续（首次即从头开始）
  if (musicUrl.value && audioEl.value) {
    audioEl.value.volume = musicVolume.value;
    audioEl.value.play().catch(() => {});
  }

  if (delayRemain.value > 0) {
    runDelay(delayRemain.value); // 暂停恢复：继续剩余延时
  } else if (flatIndex.value === 0 && litIndex.value === -1) {
    const d = clampDelay();
    if (d > 0) runDelay(d * 1000); // 全新播放：先出音乐 + 延时倒计时
    else tick();
  } else {
    tick();
  }
}

function pause() {
  isPlaying.value = false;
  clearTimeout(timer);
  if (delayTimer) {
    clearInterval(delayTimer);
    delayTimer = null;
  }
  if (audioEl.value) audioEl.value.pause();
}

function stop() {
  isPlaying.value = false;
  clearTimeout(timer);
  if (delayTimer) {
    clearInterval(delayTimer);
    delayTimer = null;
  }
  delayRemain.value = 0;
  flatIndex.value = 0;
  litIndex.value = -1;
  if (audioEl.value) {
    audioEl.value.pause();
    audioEl.value.currentTime = 0;
  }
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

// 音量实时生效
watch(musicVolume, (v) => {
  if (audioEl.value) audioEl.value.volume = Math.min(1, Math.max(0, v));
});

// 空格键：播放 / 暂停
function onKeydown(e) {
  if (e.code !== 'Space') return;
  const t = e.target;
  if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
  e.preventDefault();
  if (isPlaying.value) pause();
  else play();
}
window.addEventListener('keydown', onKeydown);

onBeforeUnmount(() => {
  clearTimeout(timer);
  clearTimeout(toastTimer);
  clearInterval(delayTimer);
  window.removeEventListener('keydown', onKeydown);
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
      <template v-if="annotationMode">
        <button class="btn" :class="{ active: markMode === 'rows' }" @click="setMarkMode('rows')">标注行</button>
        <button class="btn" :class="{ active: markMode === 'notes' }" @click="setMarkMode('notes')">标序号</button>
        <label v-if="markMode === 'rows'" class="field">行高%
          <input type="number" class="num" min="1" max="20" step="0.5" v-model.number="rowHeightPct" />
        </label>
      </template>
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

      <label class="btn">导入音乐
        <input type="file" accept="audio/*" @change="onMusicChange" hidden />
      </label>
      <span v-if="musicName" class="music-name" :title="musicName">🎵 {{ musicName }}</span>
      <button v-if="musicUrl" class="btn danger" @click="removeMusic">移除</button>
      <label class="field">延时(秒)
        <input type="number" class="num num-delay" min="0" max="60" step="0.1" v-model.number="musicDelay" />
      </label>
      <label class="field check">
        <input type="checkbox" v-model="countIn" /> 延时打点
      </label>
      <label class="field">音乐音量
        <input type="range" class="vol" min="0" max="1" step="0.05" v-model.number="musicVolume" />
      </label>

      <span class="sep"></span>

      <button v-if="!isPlaying" class="btn primary" @click="play">▶ 播放</button>
      <button v-else class="btn warn" @click="pause">⏸ 暂停</button>
      <button class="btn" @click="stop">⏹ 停止</button>
    </div>

    <div class="status">
      <template v-if="annotationMode && markMode === 'rows'">
        已标 <b>{{ rows.length }}</b> 行。移动鼠标定位，点击固定行光带（行高可调）；全部行标完后切到「标序号」。
      </template>
      <template v-else-if="annotationMode">
        共 <b>{{ rows.length }}</b> 行，已标 <b>{{ totalNotes }}</b> 个序号。点击行光带内添加序号，行内自动按位置编号。
      </template>
      <template v-else>
        共 <b>{{ rows.length }}</b> 行，<b>{{ totalNotes }}</b> 个音标。
        <template v-if="isPlaying && delayRemain > 0">
          <template v-if="musicUrl">音乐播放中，</template><b>{{ (delayRemain / 1000).toFixed(1) }}</b> 秒后开始显示标注…
        </template>
        <template v-else-if="isPlaying">播放中…</template>
      </template>
    </div>

    <div class="surface-wrap" ref="surfaceWrap">
      <div v-if="loading" class="loading">正在加载文件…</div>
      <div v-if="imgUrl" class="surface" ref="surface" @click="onSurfaceClick"
           @mousemove="onSurfaceMove" @mouseleave="onSurfaceLeave"
           :class="{ crosshair: annotationMode && !isPlaying }">
        <img :src="imgUrl" class="score-img" alt="鼓谱" />

        <!-- 行光带 + 序号点：仅在标注模式下显示，退出后隐藏，保持谱面干净 -->
        <template v-if="annotationMode">
          <div v-for="b in rowBands" :key="'band' + b.row" class="row-band"
               :style="{ top: b.top * 100 + '%', height: b.height * 100 + '%' }">
            <span class="band-label">第{{ b.row }}行</span>
          </div>

          <div v-if="previewBand" class="row-band preview"
               :style="{ top: previewBand.top * 100 + '%', height: previewBand.height * 100 + '%' }"></div>

          <div v-for="m in markers" :key="m.ri + '-' + m.si" class="marker"
               :style="{ left: m.x * 100 + '%', top: m.y * 100 + '%' }">
            <span class="seq">{{ m.seq }}</span>
          </div>
        </template>

        <!-- 播放高亮块：占满所在行高，宽度为序号标记宽度 -->
        <div v-if="cursorNote" class="cursor" ref="cursorEl"
             :style="{ left: cursorNote.x * 100 + '%', top: cursorNote.top * 100 + '%', height: cursorNote.height * 100 + '%' }"></div>
      </div>
      <div v-else-if="!loading" class="empty">
        <p>请点击上方「上传鼓谱」按钮，选择图片或 PDF 文件。</p>
        <p class="hint">上传后点「手动标注」：先移动鼠标点击固定行光带（行高可调），全部行标完切到「标序号」，在行内点击添加序号。标注可保存，之后按行号、序号顺序播放。</p>
      </div>

      <!-- 延时倒计时遮罩 -->
      <div v-if="isPlaying && delayRemain > 0" class="countdown">
        {{ Math.ceil(delayRemain / 1000) }}
      </div>
    </div>

    <!-- 背景音乐 -->
    <audio v-if="musicUrl" ref="audioEl" :src="musicUrl" preload="auto"></audio>

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
.music-name {
  font-size: 13px;
  color: #4e5969;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.num-delay { width: 58px; }
.vol { width: 84px; accent-color: #2563eb; }
.countdown {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 96px;
  font-weight: 700;
  color: #1f2329;
  background: rgba(255, 255, 255, 0.72);
  pointer-events: none;
  z-index: 5;
}
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
.row-band {
  position: absolute;
  left: 0;
  right: 0;
  background: rgba(37, 99, 235, 0.10);
  border-top: 1px dashed rgba(37, 99, 235, 0.5);
  border-bottom: 1px dashed rgba(37, 99, 235, 0.5);
  pointer-events: none;
}
.row-band.preview {
  z-index: 3;
  background: rgba(37, 99, 235, 0.18);
  border: 1px dashed #2563eb;
}
.band-label {
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
  background: #dc2626;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
}
.cursor {
  position: absolute;
  width: 28px;
  margin-left: -14px;
  border-radius: 6px;
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
