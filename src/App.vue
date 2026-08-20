<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount, toRaw } from 'vue';
import { resumeAudio, playDrumHit } from './lib/drumSound.js';

// 云端配置（仅读环境变量判断是否启用；Supabase 客户端按需动态加载，减小首屏包体）
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const cloudReady = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
let cloudApi = null;
async function ensureCloud() {
  if (!cloudApi) cloudApi = await import('./lib/cloud.js');
  return cloudApi;
}

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

// 重复区间（支持多个，互不重叠）：[{id,startRow,startSeq,endRow,endSeq,count}]
const repeatRegions = ref([]);
const repeatSel = ref(null); // 待定起点 {ri,si}：点了第一个还没点第二个
const newRegionCount = ref(2); // 新建区间的默认次数
let regionIdSeed = 1;

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

// ---------- 账号 / 云同步 ----------
const user = ref(null);
const showAuth = ref(false);
const authMode = ref('login'); // 'login' | 'register'
const authEmail = ref('');
const authPassword = ref('');
const authBusy = ref(false);
const cloudNames = ref([]); // 云端标注列表 [{id,name,updated_at}]
const selectedCloud = ref('');

function openAuth(mode) {
  authMode.value = mode;
  showAuth.value = true;
}

// 常见 Supabase 错误翻译
function authErrText(e) {
  const m = String((e && (e.message || e.error_description)) || '未知错误');
  if (/invalid login/i.test(m)) return '邮箱或密码错误';
  if (/already registered/i.test(m)) return '该邮箱已注册';
  if (/failed to fetch/i.test(m)) return '网络连接失败，请检查网络或 Supabase 配置';
  return m;
}

async function doAuth() {
  if (!cloudReady) {
    toast('云端功能未配置：请先在 .env 填入 Supabase 参数');
    return;
  }
  const email = authEmail.value.trim();
  const pwd = authPassword.value;
  if (!email || !pwd) {
    toast('请输入邮箱和密码');
    return;
  }
  authBusy.value = true;
  try {
    const m = await ensureCloud();
    if (authMode.value === 'login') {
      await m.signIn(email, pwd);
      toast('登录成功');
    } else {
      const r = await m.signUp(email, pwd);
      if (r.needsConfirm) {
        toast('注册成功，请到邮箱完成验证后再登录');
        authMode.value = 'login';
        return;
      }
      toast('注册成功');
    }
    showAuth.value = false;
    authEmail.value = '';
    authPassword.value = '';
  } catch (err) {
    toast('操作失败：' + authErrText(err));
  } finally {
    authBusy.value = false;
  }
}

async function doLogout() {
  if (cloudApi) await cloudApi.signOut();
  toast('已退出登录');
}

// 登录态变化 → 刷新云端列表
watch(user, (u) => {
  cloudNames.value = [];
  selectedCloud.value = '';
  if (u) refreshCloud();
});

async function refreshCloud() {
  if (!user.value) return;
  try {
    const list = await (await ensureCloud()).cloudList();
    cloudNames.value = list;
    if (!selectedCloud.value && list.length) selectedCloud.value = list[0].id;
  } catch (err) {
    toast('云端列表获取失败：' + authErrText(err));
  }
}

async function cloudSaveNow() {
  if (!user.value) {
    openAuth('login');
    toast('请先登录账号');
    return;
  }
  const name = (saveName.value || '').trim() || (fileName.value || '未命名');
  try {
    const id = await (await ensureCloud()).cloudSave(name, buildData());
    await refreshCloud();
    selectedCloud.value = id;
    toast('已同步到云端：' + name);
  } catch (err) {
    toast('云同步失败：' + authErrText(err));
  }
}

async function cloudLoadNow() {
  if (!selectedCloud.value) {
    toast('云端没有可读取的标注');
    return;
  }
  try {
    const row = await (await ensureCloud()).cloudLoad(selectedCloud.value);
    applyData(row.data);
    toast('已读取云端标注：' + row.name);
  } catch (err) {
    toast('云读取失败：' + authErrText(err));
  }
}

async function cloudDeleteNow() {
  const id = selectedCloud.value;
  if (!id) return;
  const item = cloudNames.value.find((c) => c.id === id);
  if (!confirm('删除云端保存的标注「' + (item ? item.name : '') + '」？')) return;
  try {
    await (await ensureCloud()).cloudDelete(id);
    toast('已删除云端标注');
    selectedCloud.value = '';
    refreshCloud();
  } catch (err) {
    toast('云端删除失败：' + authErrText(err));
  }
}

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
    row.notes.forEach((n, si) => out.push({ x: n.x, ri, si }));
  });
  return out;
});

// 解析每个区间的 flatNotes 下标；序号被删/移动后自动失效；区间间不允许重叠
const repeatRanges = computed(() => {
  const notes = flatNotes.value;
  const out = [];
  for (const r of repeatRegions.value) {
    const s = notes.findIndex((n) => n.ri === r.startRow && n.si === r.startSeq);
    const e = notes.findIndex((n) => n.ri === r.endRow && n.si === r.endSeq);
    if (s < 0 || e < 0 || s === e) continue;
    const [start, end] = s < e ? [s, e] : [e, s];
    const count = Math.min(20, Math.max(2, Number(r.count) || 2));
    out.push({ id: r.id, start, end, count, startNote: notes[start], endNote: notes[end] });
  }
  out.sort((a, b) => a.start - b.start);
  // 丢弃重叠区间，保证播放序列无歧义
  const kept = [];
  for (const r of out) {
    if (kept.length && r.start <= kept[kept.length - 1].end) continue;
    kept.push(r);
  }
  return kept;
});

// 实际播放计划：区间前 → 各区间×次数（区间间正常衔接）→ 末尾
const playPlan = computed(() => {
  const total = flatNotes.value.length;
  const plan = [];
  const ranges = repeatRanges.value;
  let pos = 0;
  ranges.forEach((r, idx) => {
    for (let i = pos; i < r.start; i++) plan.push({ fi: i, region: -1 });
    for (let k = 0; k < r.count; k++) {
      for (let i = r.start; i <= r.end; i++) {
        plan.push({ fi: i, region: idx, pass: k + 1, total: r.count });
      }
    }
    pos = r.end + 1;
  });
  for (let i = pos; i < total; i++) plan.push({ fi: i, region: -1 });
  return plan;
});

const playSeq = computed(() => playPlan.value.map((p) => p.fi));

// 当前播放位置所在区间与遍数（region=-1 表示不在区间内）
const curPlan = computed(() => {
  const i = litIndex.value;
  const plan = playPlan.value;
  return i >= 0 && i < plan.length ? plan[i] : null;
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
  const seq = playSeq.value;
  if (i < 0 || i >= seq.length) return null;
  const fn = flatNotes.value[seq[i]];
  if (!fn) return null;
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
      // pdf.js 体积大，仅在实际上传 PDF 时才动态加载
      const { renderPdfToImage } = await import('./lib/pdf.js');
      const res = await renderPdfToImage(buf, 2);
      imgUrl.value = res.url;
    } else {
      imgUrl.value = URL.createObjectURL(file);
    }
    // 新文件默认不加载旧标注
    rows.value = [];
    undoStack = [];
    repeatRegions.value = [];
    repeatSel.value = null;
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
  if (m === 'repeat' && !totalNotes.value) {
    toast('请先标注序号');
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
  } else if (markMode.value === 'notes') {
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
  // repeat 模式下点击空白无操作，区间通过点击序号设置
}

// ---------- 重复区间（支持多个） ----------
function onMarkerClick(e, m) {
  if (markMode.value !== 'repeat') return;
  e.stopPropagation();
  if (!repeatSel.value) {
    repeatSel.value = { ri: m.ri, si: m.si };
    toast('起点：第' + (m.ri + 1) + '行 ' + (m.si + 1) + '，请点击终点');
    return;
  }
  if (repeatSel.value.ri === m.ri && repeatSel.value.si === m.si) {
    toast('起点终点相同，请重新选择');
    return;
  }
  // 与已有区间重叠则拒绝
  const notes = flatNotes.value;
  const s = notes.findIndex((n) => n.ri === repeatSel.value.ri && n.si === repeatSel.value.si);
  const t = notes.findIndex((n) => n.ri === m.ri && n.si === m.si);
  const [a, b] = s < t ? [s, t] : [t, s];
  if (repeatRanges.value.some((r) => a <= r.end && b >= r.start)) {
    toast('与已有区间重叠，请重新选择');
    repeatSel.value = null;
    return;
  }
  const count = Math.min(20, Math.max(2, Number(newRegionCount.value) || 2));
  repeatRegions.value.push({
    id: regionIdSeed++,
    startRow: repeatSel.value.ri,
    startSeq: repeatSel.value.si,
    endRow: m.ri,
    endSeq: m.si,
    count,
  });
  repeatSel.value = null;
  toast('已添加重复区间，走 ' + count + ' 遍');
}

function removeRegion(id) {
  repeatRegions.value = repeatRegions.value.filter((r) => r.id !== id);
}

function clearRepeat() {
  repeatRegions.value = [];
  repeatSel.value = null;
}

function clampRegionCount(r) {
  r.count = Math.min(20, Math.max(2, Number(r.count) || 2));
}

// 序号点的动态样式：重复模式可点、各区间起点绿/终点红/区间内黄
function markerClass(m) {
  const cls = {};
  if (markMode.value !== 'repeat') return cls;
  cls.pickable = true;
  const same = (a, b) => a.ri === b.ri && a.si === b.si;
  let isStart = false;
  let isEnd = false;
  let inRange = false;
  for (const r of repeatRanges.value) {
    if (same(m, r.startNote)) isStart = true;
    else if (same(m, r.endNote)) isEnd = true;
    else if (inRepeatRange(m, r)) inRange = true;
  }
  if (isStart) cls['rep-start'] = true;
  else if (isEnd) cls['rep-end'] = true;
  else if (inRange) cls['in-repeat'] = true;
  if (repeatSel.value && same(m, repeatSel.value)) cls['rep-pick'] = true;
  return cls;
}

function inRepeatRange(m, r) {
  const ge = (a) => a.ri > r.startNote.ri || (a.ri === r.startNote.ri && a.si >= r.startNote.si);
  const le = (a) => a.ri < r.endNote.ri || (a.ri === r.endNote.ri && a.si <= r.endNote.si);
  return ge(m) && le(m);
}

// 撤销：rows/notes 被 Vue 响应式代理包装后 proxy !== 原对象，
// 栈里存的是原始引用，比较时必须 toRaw 还原，否则过滤永远不命中
function undoPoint() {
  if (!annotationMode.value) return;
  const last = undoStack.pop();
  if (!last) return;
  if (last.type === 'row') {
    rows.value = rows.value.filter((r) => toRaw(r) !== last.row);
  } else {
    last.row.notes = last.row.notes.filter((n) => toRaw(n) !== last.note);
  }
}

function clearAnnotations() {
  if (!confirm('确定清空全部标注吗？')) return;
  rows.value = [];
  undoStack = [];
  repeatRegions.value = [];
  repeatSel.value = null;
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
    repeats: repeatRegions.value.map((r) => ({ ...r })),
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
  // 兼容旧单区间格式（repeat + repeatCount）
  const list = Array.isArray(data.repeats)
    ? data.repeats
    : data.repeat
      ? [{ ...data.repeat, count: data.repeatCount }]
      : [];
  repeatRegions.value = list
    .filter((r) => r && typeof r.startRow === 'number' && typeof r.endRow === 'number')
    .map((r) => ({
      id: regionIdSeed++,
      startRow: r.startRow,
      startSeq: r.startSeq || 0,
      endRow: r.endRow,
      endSeq: r.endSeq || 0,
      count: Math.min(20, Math.max(2, Number(r.count) || 2)),
    }));
  repeatSel.value = null;
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
  const seq = playSeq.value;
  if (flatIndex.value >= seq.length) {
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
  if (flatIndex.value >= playSeq.value.length) {
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

// 云端登录态初始化（后台加载，不阻塞首屏）
if (cloudReady) {
  ensureCloud().then((m) => {
    m.currentUser().then((u) => {
      user.value = u;
    });
    m.onAuthChange((u) => {
      user.value = u;
    });
  });
}

refreshSavedList();
</script>

<template>
  <div class="app">
    <!-- 顶栏 -->
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">🥁</span>
        <div class="brand-text">
          <span class="brand-name">鼓谱标注播放器</span>
          <span class="brand-sub">Drum Score Studio</span>
        </div>
      </div>
      <label class="file-btn">
        上传鼓谱
        <input type="file" accept="image/*,application/pdf" @change="onFileChange" hidden />
      </label>
      <span class="filename" :title="fileName">{{ fileName || '未加载文件' }}</span>

      <div class="flex-spacer"></div>

      <!-- 账号区 -->
      <template v-if="cloudReady">
        <div v-if="user" class="user-chip">
          <span class="avatar">{{ (user.email || 'U').slice(0, 1).toUpperCase() }}</span>
          <span class="user-email">{{ user.email }}</span>
          <button class="link-btn" @click="doLogout">退出</button>
        </div>
        <button v-else class="btn ghost" @click="openAuth('login')">登录 / 注册</button>
      </template>
      <span v-else class="cloud-off" title="在 .env 中配置 Supabase 后可启用云同步">☁ 云端未配置</span>
    </header>

    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="tgroup">
        <span class="tlabel">标注</span>
        <button class="btn" :class="{ active: annotationMode }" @click="toggleAnnotation">
          {{ annotationMode ? '退出标注' : '手动标注' }}
        </button>
        <template v-if="annotationMode">
          <button class="btn" :class="{ active: markMode === 'rows' }" @click="setMarkMode('rows')">行</button>
          <button class="btn" :class="{ active: markMode === 'notes' }" @click="setMarkMode('notes')">序号</button>
          <button class="btn" :class="{ active: markMode === 'repeat' }" @click="setMarkMode('repeat')">重复</button>
          <label v-if="markMode === 'rows'" class="field">行高%
            <input type="number" class="num" min="1" max="20" step="0.5" v-model.number="rowHeightPct" />
          </label>
          <template v-if="markMode === 'repeat'">
            <label class="field">次数
              <input type="number" class="num" min="2" max="20" v-model.number="newRegionCount" />
            </label>
            <button v-if="repeatRegions.length" class="btn danger" @click="clearRepeat">清空区间</button>
          </template>
        </template>
        <button class="btn" :disabled="!annotationMode" @click="undoPoint">撤销</button>
        <button class="btn danger" @click="clearAnnotations">清空</button>
      </div>

      <div class="tgroup">
        <span class="tlabel">本地</span>
        <button class="btn" @click="saveAnnotations">保存</button>
        <select v-model="selectedSaved" class="sel">
          <option v-for="n in savedNames" :key="n" :value="n">{{ n }}</option>
        </select>
        <button class="btn" @click="loadAnnotations">读取</button>
        <button class="btn" @click="deleteSaved">删除</button>
        <button class="btn" @click="exportJson">导出</button>
        <button class="btn" @click="onImportClick">导入</button>
        <input ref="importInput" type="file" accept="application/json" hidden @change="onImportChange" />
      </div>

      <div v-if="cloudReady && user" class="tgroup">
        <span class="tlabel">云端</span>
        <button class="btn accent" @click="cloudSaveNow">同步</button>
        <select v-model="selectedCloud" class="sel">
          <option v-for="c in cloudNames" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <button class="btn" @click="cloudLoadNow">读取</button>
        <button class="btn danger" @click="cloudDeleteNow">删除</button>
      </div>

      <div class="tgroup">
        <span class="tlabel">播放</span>
        <label class="field">BPM
          <input type="number" class="num" min="20" max="400" v-model.number="bpm" />
        </label>
        <label class="field check">
          <input type="checkbox" v-model="soundOn" /> 鼓声
        </label>
        <label class="btn">导入音乐
          <input type="file" accept="audio/*" @change="onMusicChange" hidden />
        </label>
        <span v-if="musicName" class="music-name" :title="musicName">🎵 {{ musicName }}</span>
        <button v-if="musicUrl" class="btn danger" @click="removeMusic">移除</button>
        <label class="field">延时
          <input type="number" class="num num-delay" min="0" max="60" step="0.1" v-model.number="musicDelay" />秒
        </label>
        <label class="field check">
          <input type="checkbox" v-model="countIn" /> 打点
        </label>
        <input type="range" class="vol" min="0" max="1" step="0.05" v-model.number="musicVolume" title="音乐音量" />
        <button v-if="!isPlaying" class="btn primary" @click="play">▶ 播放</button>
        <button v-else class="btn primary" @click="pause">⏸ 暂停</button>
        <button class="btn" @click="stop" title="停止">⏹</button>
      </div>
    </div>

    <!-- 状态栏 -->
    <div class="status">
      <template v-if="annotationMode && markMode === 'rows'">
        已标 <b>{{ rows.length }}</b> 行。移动鼠标定位，点击固定行光带（行高可调）；全部行标完后切到「序号」。
      </template>
      <template v-else-if="annotationMode && markMode === 'notes'">
        共 <b>{{ rows.length }}</b> 行，已标 <b>{{ totalNotes }}</b> 个序号。点击行光带内添加序号，行内自动按位置编号。
      </template>
      <template v-else-if="annotationMode">
        点击两个序号设为一个重复区间（可跨行），可添加多个互不重叠的区间，播放时各自按次数重复走。起点<mark class="pill pill-start">绿</mark>、终点<mark class="pill pill-end">红</mark>、区间内<mark class="pill pill-in">黄</mark>。
        <div v-if="repeatRegions.length" class="region-list">
          <span v-for="(r, i) in repeatRegions" :key="r.id" class="region-chip">
            区间{{ i + 1 }}：{{ r.startRow + 1 }}行{{ r.startSeq + 1 }}~{{ r.endRow + 1 }}行{{ r.endSeq + 1 }}
            ×<input class="chip-num" type="number" min="2" max="20"
                    v-model.number="r.count" @change="clampRegionCount(r)" />遍
            <button class="chip-del" title="删除该区间" @click="removeRegion(r.id)">✕</button>
          </span>
        </div>
      </template>
      <template v-else>
        共 <b>{{ rows.length }}</b> 行，<b>{{ totalNotes }}</b> 个音标。
        <template v-if="repeatRanges.length">
          重复区间 {{ repeatRanges.length }} 个：<template v-for="(r, i) in repeatRanges" :key="r.id">{{ i ? '；' : '' }}{{ r.startNote.ri + 1 }}行{{ r.startNote.si + 1 }}~{{ r.endNote.ri + 1 }}行{{ r.endNote.si + 1 }}×{{ r.count }}遍</template>。
        </template>
        <template v-if="isPlaying && delayRemain > 0">
          <template v-if="musicUrl">音乐播放中，</template><b>{{ (delayRemain / 1000).toFixed(1) }}</b> 秒后开始显示标注…
        </template>
        <template v-else-if="isPlaying">播放中… 第 <b>{{ litIndex + 1 }}</b>/{{ playSeq.length }} 个<template v-if="curPlan && curPlan.region >= 0">（第 {{ curPlan.pass }}/{{ curPlan.total }} 遍）</template></template>
      </template>
    </div>

    <!-- 谱面 -->
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
               :class="markerClass(m)" @click="onMarkerClick($event, m)"
               :style="{ left: m.x * 100 + '%', top: m.y * 100 + '%' }">
            <span class="seq">{{ m.seq }}</span>
          </div>
        </template>

        <!-- 播放高亮块：占满所在行高，宽度为序号标记宽度 -->
        <div v-if="cursorNote" class="cursor" ref="cursorEl"
             :style="{ left: cursorNote.x * 100 + '%', top: cursorNote.top * 100 + '%', height: cursorNote.height * 100 + '%' }"></div>
      </div>
      <div v-else-if="!loading" class="empty">
        <div class="empty-icon">🥁</div>
        <p>请点击上方「上传鼓谱」按钮，选择图片或 PDF 文件。</p>
        <p class="hint">上传后点「手动标注」：先点击固定行光带（行高可调），再切「序号」在行内点击编号；需要反复练习的片段可用「重复」点击起止序号，播放时自动多走几遍。标注可保存到本地或云端。</p>
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

    <!-- 登录 / 注册弹窗 -->
    <div v-if="showAuth" class="modal-mask" @click.self="showAuth = false">
      <div class="modal">
        <div class="modal-title">账号</div>
        <div class="modal-sub">登录后标注可同步到云端，换电脑也能用</div>
        <div class="modal-tabs">
          <button :class="{ on: authMode === 'login' }" @click="authMode = 'login'">登录</button>
          <button :class="{ on: authMode === 'register' }" @click="authMode = 'register'">注册</button>
        </div>
        <input v-model="authEmail" type="email" class="modal-input" placeholder="邮箱"
               @keyup.enter="doAuth" />
        <input v-model="authPassword" type="password" class="modal-input"
               :placeholder="authMode === 'login' ? '密码' : '密码（至少 6 位）'"
               @keyup.enter="doAuth" />
        <button class="btn primary block" :disabled="authBusy" @click="doAuth">
          {{ authBusy ? '处理中…' : (authMode === 'login' ? '登 录' : '注 册') }}
        </button>
        <p class="modal-tip">同一账号在不同电脑登录，即可读取云端标注；谱面图片和音乐文件仍保留在本地。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #0c0e13;
  color: #e6e8ee;
}

/* ---------- 顶栏 ---------- */
.topbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 16px;
  height: 54px;
  flex-shrink: 0;
  background: #10131a;
  border-bottom: 1px solid #232836;
}
.brand { display: flex; align-items: center; gap: 10px; }
.brand-mark { font-size: 22px; }
.brand-text { display: flex; flex-direction: column; line-height: 1.2; }
.brand-name { font-weight: 700; font-size: 14px; letter-spacing: 0.5px; }
.brand-sub { font-size: 10px; color: #5f6675; letter-spacing: 2px; text-transform: uppercase; }
.flex-spacer { flex: 1; }
.file-btn {
  cursor: pointer;
  padding: 7px 16px;
  background: #f59e0b;
  color: #1a1206;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.file-btn:hover { background: #ffb224; }
.filename {
  font-size: 12px;
  color: #8b92a3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 24vw;
}
.user-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 4px 4px;
  background: #1a1e28;
  border: 1px solid #2a3040;
  border-radius: 999px;
}
.avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #f59e0b;
  color: #1a1206;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.user-email {
  font-size: 12px;
  color: #c7ccd8;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link-btn {
  background: none;
  border: none;
  color: #8b92a3;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
}
.link-btn:hover { color: #e6e8ee; }
.cloud-off { font-size: 12px; color: #5f6675; white-space: nowrap; }

/* ---------- 工具栏 ---------- */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 20px;
  padding: 10px 16px;
  flex-shrink: 0;
  background: #14171f;
  border-bottom: 1px solid #232836;
}
.tgroup { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tlabel {
  font-size: 11px;
  color: #5f6675;
  letter-spacing: 3px;
  margin-right: 2px;
  user-select: none;
  white-space: nowrap;
}
.btn {
  padding: 5px 12px;
  border: 1px solid #2a3040;
  background: #1a1e28;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12px;
  color: #c7ccd8;
  white-space: nowrap;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.btn:hover:not(:disabled) { border-color: #3d465c; color: #fff; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
.btn.primary { background: #f59e0b; border-color: #f59e0b; color: #1a1206; font-weight: 600; }
.btn.primary:hover:not(:disabled) { background: #ffb224; border-color: #ffb224; color: #1a1206; }
.btn.accent { border-color: #8a5f10; color: #f5b942; }
.btn.accent:hover:not(:disabled) { border-color: #f59e0b; color: #ffc94d; }
.btn.ghost { background: transparent; }
.btn.danger { color: #e5484d; }
.btn.danger:hover:not(:disabled) { border-color: #e5484d; color: #ff6b70; }
.btn.block { width: 100%; padding: 9px 0; font-size: 13px; }
.sel {
  padding: 5px 8px;
  border: 1px solid #2a3040;
  background: #1a1e28;
  color: #c7ccd8;
  border-radius: 7px;
  font-size: 12px;
  max-width: 150px;
}
.field { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: #8b92a3; white-space: nowrap; }
.num {
  width: 56px;
  padding: 5px 6px;
  border: 1px solid #2a3040;
  background: #1a1e28;
  color: #e6e8ee;
  border-radius: 7px;
  font-size: 12px;
}
.num-delay { width: 46px; }
.check { cursor: pointer; }
.vol { width: 72px; accent-color: #f59e0b; }
.music-name {
  font-size: 12px;
  color: #8b92a3;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 状态栏 ---------- */
.status {
  padding: 7px 16px;
  font-size: 12px;
  color: #8b92a3;
  background: #10131a;
  border-bottom: 1px solid #232836;
  flex-shrink: 0;
  line-height: 1.7;
}
.status b { color: #e6e8ee; }

/* ---------- 谱面 ---------- */
.surface-wrap {
  flex: 1;
  overflow: auto;
  position: relative;
  padding: 28px;
}
.surface {
  position: relative;
  display: inline-block;
  max-width: 100%;
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
}
.score-img {
  display: block;
  max-width: 100%;
  user-select: none;
  border-radius: 10px;
  background: #fff;
}
.surface.crosshair { cursor: crosshair; }
.loading, .empty {
  text-align: center;
  color: #6b7280;
  padding: 80px 20px;
}
.empty-icon { font-size: 44px; margin-bottom: 12px; opacity: 0.7; }
.empty p { font-size: 14px; }
.empty .hint { font-size: 12px; max-width: 560px; margin: 12px auto 0; line-height: 1.9; }

/* 延时倒计时遮罩 */
.countdown {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 112px;
  font-weight: 800;
  color: #f5a623;
  background: rgba(12, 14, 19, 0.8);
  pointer-events: none;
  z-index: 5;
}

/* ---------- 标注元素 ---------- */
.marker {
  position: absolute;
  width: 24px;
  height: 24px;
  margin: -12px 0 0 -12px;
  border-radius: 50%;
  background: #3b82f6;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px #3b82f6;
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
.marker.pickable { pointer-events: auto; cursor: pointer; }
.marker.rep-pick { background: #22c55e; box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.45); }
.marker.rep-start { background: #22c55e; box-shadow: 0 0 0 1px #22c55e; }
.marker.rep-end { background: #e5484d; box-shadow: 0 0 0 1px #e5484d; }
.marker.in-repeat { background: #f59e0b; box-shadow: 0 0 0 1px #f59e0b; }

.pill {
  display: inline-block;
  padding: 0 6px;
  margin: 0 1px;
  border-radius: 999px;
  color: #fff;
  font-size: 11px;
  background: #5f6675;
}
.pill-start { background: #22c55e; }
.pill-end { background: #e5484d; }
.pill-in { background: #f59e0b; }

.region-list {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.region-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #1c2233;
  border: 1px solid #2e3a55;
  color: #9db4f5;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
  white-space: nowrap;
}
.chip-num {
  width: 42px;
  padding: 1px 4px;
  border: 1px solid #2e3a55;
  background: #14171f;
  color: #e6e8ee;
  border-radius: 4px;
  font-size: 12px;
}
.chip-del {
  border: none;
  background: transparent;
  color: #e5484d;
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  line-height: 1;
}

.row-band {
  position: absolute;
  left: 0;
  right: 0;
  background: rgba(59, 130, 246, 0.12);
  border-top: 1px dashed rgba(59, 130, 246, 0.55);
  border-bottom: 1px dashed rgba(59, 130, 246, 0.55);
  pointer-events: none;
}
.row-band.preview {
  z-index: 3;
  background: rgba(59, 130, 246, 0.2);
  border: 1px dashed #3b82f6;
}
.band-label {
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
  background: #e5484d;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
}

/* 播放高亮块 */
.cursor {
  position: absolute;
  width: 28px;
  margin-left: -14px;
  border-radius: 6px;
  background: rgba(250, 204, 21, 0.35);
  border: 3px solid #f59e0b;
  box-shadow: 0 0 16px rgba(245, 158, 11, 0.9);
  pointer-events: none;
}

/* ---------- 轻提示 ---------- */
.toast {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  background: #1a1e28;
  color: #e6e8ee;
  border: 1px solid #2a3040;
  padding: 10px 18px;
  border-radius: 10px;
  font-size: 13px;
  z-index: 9999;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.55);
  pointer-events: none;
  white-space: nowrap;
}
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.25s ease;
}
.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
}

/* ---------- 登录 / 注册弹窗 ---------- */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(5, 6, 10, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  width: 340px;
  background: #14171f;
  border: 1px solid #2a3040;
  border-radius: 14px;
  padding: 24px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
}
.modal-title { font-size: 16px; font-weight: 700; }
.modal-sub { font-size: 12px; color: #6b7280; margin: 4px 0 16px; }
.modal-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
  background: #0f1218;
  border-radius: 9px;
  padding: 4px;
}
.modal-tabs button {
  flex: 1;
  padding: 7px 0;
  border: none;
  background: transparent;
  color: #8b92a3;
  border-radius: 7px;
  cursor: pointer;
  font-size: 13px;
}
.modal-tabs button.on { background: #262b38; color: #fff; }
.modal-input {
  width: 100%;
  padding: 9px 12px;
  margin-bottom: 10px;
  border: 1px solid #2a3040;
  background: #0f1218;
  color: #e6e8ee;
  border-radius: 9px;
  font-size: 13px;
  outline: none;
}
.modal-input:focus { border-color: #f59e0b; }
.modal-tip { font-size: 11px; color: #5f6675; margin: 12px 0 0; line-height: 1.7; }
</style>
