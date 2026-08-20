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

export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  // 部分配置下注册后需先验证邮箱（data.user 存在但 session 为空）
  return { user: data.user, needsConfirm: !data.session };
}

export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
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
  const { data: user } = await sb.auth.getUser();
  if (!user) throw new Error('未登录');
  // 同名覆盖：先查再 upsert（按 user_id + name 唯一）
  const { data: existing } = await sb
    .from('scores')
    .select('id')
    .eq('user_id', user.id)
    .eq('name', name)
    .maybeSingle();
  if (existing) {
    const { error } = await sb
      .from('scores')
      .update({ data: payload, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) throw error;
    return existing.id;
  }
  const { data, error } = await sb
    .from('scores')
    .insert({ user_id: user.id, name, data: payload })
    .select('id')
    .single();
  if (error) throw error;
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
