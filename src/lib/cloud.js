// 云账号 + 云同步（Supabase）
// 使用前需配置 .env：VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// 并在 Supabase 控制台执行建表 SQL（见 .env.example 内说明）
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// 未配置时为 null，调用方据此隐藏云端功能并提示
export const cloudReady = Boolean(url && anonKey);

const sb = cloudReady ? createClient(url, anonKey) : null;

// ---------- 账号 ----------
export function currentUser() {
  return sb ? sb.auth.getUser().then((r) => r.data.user) : Promise.resolve(null);
}

// 注册已关闭（商用模式）：账号由管理员在 Supabase 后台创建
export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

// ---------- 邮件邀请：用户点链接进入应用后自行设置密码 ----------
// 邀请邮件模板需用 {{ .SiteURL }}?token_hash={{ .TokenHash }}&type=invite 构造链接
export function parseInviteLink() {
  try {
    const q = new URLSearchParams(window.location.search);
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const tokenHash = q.get('token_hash') || h.get('token_hash');
    const type = q.get('type') || h.get('type');
    return tokenHash && type === 'invite' ? { tokenHash } : null;
  } catch {
    return null;
  }
}

// 用邮件链接中的 token 建立会话（token 一次性，验证后即失效）
export async function verifyInvite(tokenHash) {
  const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type: 'invite' });
  if (error) throw error;
}

// 已登录状态下设置/修改密码
export async function updatePassword(password) {
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut() {
  if (sb) await sb.auth.signOut();
}

// 监听登录态变化（未配置时直接返回空退订函数）
export function onAuthChange(cb) {
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange((_e, session) => cb(session ? session.user : null));
  return () => data.subscription.unsubscribe();
}

// ---------- 云端标注 ----------
// 表结构 scores: id / user_id / name / data(jsonb) / updated_at
export async function cloudList() {
  const { data, error } = await sb
    .from('scores')
    .select('id, name, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function cloudSave(name, payload) {
  // RLS 已按登录身份隔离数据；user_id 由数据库默认值 auth.uid() 自动填充。
  // 客户端不传用户 id，规避会话信息不完整时出现 uuid 参数无效的问题。
  const { data: existing, error: selErr } = await sb
    .from('scores')
    .select('id')
    .eq('name', name)
    .maybeSingle();
  if (selErr) throw new Error('查询云端记录失败：' + selErr.message);
  if (existing) {
    const { error } = await sb
      .from('scores')
      .update({ data: payload, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) throw new Error('更新云端记录失败：' + error.message);
    return existing.id;
  }
  const { data, error } = await sb
    .from('scores')
    .insert({ name, data: payload })
    .select('id')
    .single();
  if (error) throw new Error('新建云端记录失败：' + error.message);
  return data.id;
}

export async function cloudLoad(id) {
  const { data, error } = await sb.from('scores').select('name, data').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function cloudDelete(id) {
  const { error } = await sb.from('scores').delete().eq('id', id);
  if (error) throw error;
}

// ---------- 账号有效期（profiles 表，管理员在后台维护 expires_at） ----------
// 返回 ISO 时间字符串；null 表示永久（表未建 / 无记录 / 字段为空均按永久处理）
export async function getAccountExpiry() {
  const { data, error } = await sb.from('profiles').select('expires_at').maybeSingle();
  if (error) return null; // 表不存在等情况不阻断登录
  if (!data || !data.expires_at) return null;
  return data.expires_at;
}

// ---------- 训练数据飞轮（用户同意后，同步时匿名上传谱面图片） ----------
// 存放于私有桶 training/{user_id}/{score_id}，同名覆盖；仅管理员可用 service key 提取训练
export async function uploadTrainingImage(userId, scoreId, blob) {
  const ext = blob && blob.type && blob.type.includes('png') ? 'png' : 'jpg';
  const path = userId + '/' + scoreId + '.' + ext;
  const { error } = await sb.storage
    .from('training')
    .upload(path, blob, {
      contentType: blob && blob.type ? blob.type : 'image/jpeg',
      upsert: true, // 同一存档重复同步时覆盖旧图
    });
  if (error) throw new Error(error.message);
}
