// 极简 Web Audio 鼓声合成（底鼓 + 军鼓噪声混合），无需音频文件
let ctx = null;

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  return ctx;
}

// 浏览器策略：音频上下文需在用户手势后恢复
export function resumeAudio() {
  const c = getCtx();
  if (c.state === 'suspended') return c.resume();
  return Promise.resolve();
}

// 生成一段白噪声 buffer（用于军鼓）
function noiseBuffer(c, duration) {
  const len = Math.floor(c.sampleRate * duration);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// 播放一次鼓击声
export function playDrumHit() {
  const c = getCtx();
  const t = c.currentTime;

  // 底鼓：频率快速下扫
  const kick = c.createOscillator();
  const kickGain = c.createGain();
  kick.type = 'sine';
  kick.frequency.setValueAtTime(160, t);
  kick.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  kickGain.gain.setValueAtTime(0.9, t);
  kickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  kick.connect(kickGain).connect(c.destination);
  kick.start(t);
  kick.stop(t + 0.22);

  // 军鼓：短促白噪声 + 高通
  const noise = c.createBufferSource();
  noise.buffer = noiseBuffer(c, 0.2);
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1500;
  const noiseGain = c.createGain();
  noiseGain.gain.setValueAtTime(0.5, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  noise.connect(hp).connect(noiseGain).connect(c.destination);
  noise.start(t);
  noise.stop(t + 0.14);
}
