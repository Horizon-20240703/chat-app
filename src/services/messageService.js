import { supabase } from '../lib/supabaseClient';

// ===============================================================
// 消息服务 — 消息收发与已读管理
// ===============================================================

/**
 * 获取与指定用户的对话消息
 * @param {string} userId - 当前用户 ID
 * @param {string} otherUserId - 对方用户 ID
 * @returns {Promise<Array>}
 */
export async function getMessages(userId, otherUserId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(
      `and(sender_id.eq.${userId},receiver_id.eq.${otherUserId}),` +
      `and(sender_id.eq.${otherUserId},receiver_id.eq.${userId})`
    )
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data;
}

/**
 * 发送消息
 * @param {string} senderId - 发送者 ID
 * @param {string} receiverId - 接收者 ID
 * @param {string} content - 消息内容
 * @param {string} contentType - 消息类型 (text / image / file)
 * @returns {Promise<object>}
 */
export async function sendMessage(senderId, receiverId, content, contentType = 'text') {
  const { data, error } = await supabase
    .from('messages')
    .insert([{
      sender_id: senderId,
      receiver_id: receiverId,
      content,
      content_type: contentType,
      is_read: false
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * 标记消息为已读
 * @param {string} userId - 当前用户 ID (接收者)
 * @param {string} otherUserId - 对方用户 ID (发送者)
 */
export async function markMessagesAsRead(userId, otherUserId) {
  const { error } = await supabase
    .from('messages')
    .update({ is_read: true })
    .eq('receiver_id', userId)
    .eq('sender_id', otherUserId)
    .eq('is_read', false);

  if (error) throw error;
}

/**
 * 获取与指定用户的未读消息数量
 * @param {string} userId - 当前用户 ID (接收者)
 * @param {string} otherUserId - 对方用户 ID (发送者)，可选
 * @returns {Promise<number>}
 */
export async function getUnreadCount(userId, otherUserId = null) {
  let query = supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('receiver_id', userId)
    .eq('is_read', false);

  if (otherUserId) {
    query = query.eq('sender_id', otherUserId);
  }

  const { count, error } = await query;
  if (error) throw error;
  return count;
}

/**
 * 获取所有未读消息数量（按发送者分组）
 * @param {string} userId - 当前用户 ID (接收者)
 * @returns {Promise<Record<string, number>>}
 */
export async function getUnreadCountBySender(userId) {
  const { data, error } = await supabase
    .from('messages')
    .select('sender_id')
    .eq('receiver_id', userId)
    .eq('is_read', false);

  if (error) throw error;

  // 按 sender_id 分组计数
  const counts = {};
  for (const msg of data) {
    counts[msg.sender_id] = (counts[msg.sender_id] || 0) + 1;
  }
  return counts;
}

/**
 * 删除消息（仅发送者可删除自己的消息）
 * @param {string} messageId - 消息 ID
 */
export async function deleteMessage(messageId) {
  const { error } = await supabase
    .from('messages')
    .delete()
    .eq('id', messageId);

  if (error) throw error;
}
