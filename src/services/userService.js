import { supabase } from '../lib/supabaseClient';

// ===============================================================
// 用户服务 — 用户查询与档案管理
// ===============================================================

/**
 * 获取所有用户档案
 * @returns {Promise<Array>}
 */
export async function getUsers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

/**
 * 获取当前用户的档案
 * @param {string} userId - 用户 ID
 * @returns {Promise<object>}
 */
export async function getCurrentUserProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) throw error;
  return data;
}

/**
 * 搜索用户
 * @param {string} query - 搜索关键词
 * @returns {Promise<Array>}
 */
export async function searchUsers(query) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('username', `%${query}%`)
    .order('username', { ascending: true })
    .limit(20);

  if (error) throw error;
  return data;
}

/**
 * 更新用户档案
 * @param {string} userId - 用户 ID
 * @param {object} updates - 要更新的字段
 */
export async function updateProfile(userId, updates) {
  const { data, error } = await supabase
    .from('profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}
