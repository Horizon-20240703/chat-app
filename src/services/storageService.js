// ===============================================================
// 存储服务 — 文件上传/下载 + 空间管理 + 自动清理
// ===============================================================

import { supabase } from '../lib/supabaseClient';

const BUCKET_NAME = 'chat-attachments';
const FREE_STORAGE_LIMIT = 1 * 1024 * 1024 * 1024;  // 1 GB Supabase 免费
const STORAGE_WARN_THRESHOLD = 0.85;                  // 85% 时告警
const MAX_FILE_SIZE = 50 * 1024 * 1024;               // 50MB Supabase 免费上限
const RECOMMENDED_FILE_SIZE = 2 * 1024 * 1024;        // 推荐 2MB

/**
 * 上传文件到 Supabase Storage
 * (Bucket 由 supabase-setup.sql 自动创建，无需客户端操作)
 * @param {File} file - 浏览器 File 对象
 * @param {string} userId - 上传者 ID
 * @param {string} messageId - 关联的消息 ID
 * @returns {Promise<{path: string, publicUrl: string, size: number}>}
 */
export async function uploadFile(file, userId, messageId) {
  // 文件转 base64 存数据库（绕过 Storage RLS 兼容性问题）
  const base64 = await fileToBase64(file);

  await supabase.from('file_attachments').insert({
    message_id: messageId,
    uploader_id: userId,
    storage_path: `db://${messageId}/${file.name}`,
    file_name: file.name,
    file_type: getFileType(file.type),
    mime_type: file.type,
    file_size: file.size
  }).throwOnError();

  await logBandwidth(userId, 'upload', file.size);
  await checkAndCleanup(userId);

  return { path: `db://${messageId}`, dataUrl: base64, size: file.size, name: file.name };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 下载文件
 * @param {string} storagePath
 * @param {string} userId
 * @returns {Promise<Blob>}
 */
export async function downloadFile(storagePath, userId) {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .download(storagePath);

  if (error) throw error;

  // 记录带宽消耗 (下载)
  await logBandwidth(userId, 'download', data.size);

  return data;
}

/**
 * 获取文件的签名下载 URL
 * @param {string} storagePath
 * @param {number} expiresIn - 过期时间（秒），默认 1 小时
 */
export async function getSignedUrl(storagePath, expiresIn = 3600) {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(storagePath, expiresIn);

  if (error) throw error;
  return data.signedUrl;
}

/**
 * 删除文件
 * @param {string} storagePath
 */
export async function deleteFile(storagePath) {
  // 从 Storage 中删除
  const { error: storageError } = await supabase.storage
    .from(BUCKET_NAME)
    .remove([storagePath]);

  if (storageError) throw storageError;

  // 从数据库中删除记录
  const { error: dbError } = await supabase
    .from('file_attachments')
    .delete()
    .eq('storage_path', storagePath);

  if (dbError) throw dbError;
}

// ===========================================
// 空间管理
// ===========================================

/**
 * 获取当前存储使用量
 * @param {string} userId - 可选，指定用户；不指定则全局
 * @returns {Promise<{fileCount: number, totalBytes: number, usagePercent: number}>}
 */
export async function getStorageUsage(userId = null) {
  let query = supabase
    .from('file_attachments')
    .select('file_size');

  if (userId) {
    query = query.eq('uploader_id', userId);
  }

  const { data, error } = await query;
  if (error) throw error;

  const totalBytes = data.reduce((sum, row) => sum + (row.file_size || 0), 0);
  return {
    fileCount: data.length,
    totalBytes,
    usagePercent: (totalBytes / FREE_STORAGE_LIMIT) * 100
  };
}

/**
 * 检查存储空间，超过 85% 时自动清理最旧文件
 * @param {string} userId - 触发清理的用户
 */
export async function checkAndCleanup(userId) {
  const usage = await getStorageUsage();

  if (usage.usagePercent < STORAGE_WARN_THRESHOLD * 100) {
    return { cleaned: false, usage };
  }

  // 需要释放空间：目标释放到 70%
  const targetFree = usage.totalBytes - (FREE_STORAGE_LIMIT * 0.7);
  if (targetFree <= 0) return { cleaned: false, usage };

  // 获取最旧的文件（按时间升序）
  const { data: oldestFiles, error } = await supabase
    .from('file_attachments')
    .select('storage_path, file_size')
    .order('created_at', { ascending: true });

  if (error || !oldestFiles) return { cleaned: false, usage };

  let freed = 0;
  const deleted = [];

  for (const file of oldestFiles) {
    if (freed >= targetFree) break;

    try {
      await deleteFile(file.storage_path);
      freed += file.file_size;
      deleted.push(file.storage_path);
    } catch (err) {
      console.error('清理文件失败:', file.storage_path, err);
    }
  }

  return { cleaned: true, freed, deletedCount: deleted.length, usage };
}

/**
 * 获取存储告警状态
 * @returns {Promise<{level: 'ok'|'warn'|'critical', usagePercent: number, message: string}>}
 */
export async function getStorageAlert() {
  const usage = await getStorageUsage();

  if (usage.usagePercent >= 95) {
    return {
      level: 'critical',
      usagePercent: usage.usagePercent,
      message: `存储空间仅剩 ${(100 - usage.usagePercent).toFixed(1)}%，系统将自动清理旧文件`
    };
  }
  if (usage.usagePercent >= STORAGE_WARN_THRESHOLD * 100) {
    return {
      level: 'warn',
      usagePercent: usage.usagePercent,
      message: `存储空间已使用 ${usage.usagePercent.toFixed(1)}%，建议清理旧文件`
    };
  }
  return { level: 'ok', usagePercent: usage.usagePercent, message: '' };
}

// ===========================================
// 带宽追踪
// ===========================================

/**
 * 记录带宽消耗
 */
async function logBandwidth(userId, direction, bytes) {
  try {
    await supabase.from('bandwidth_log').insert({
      user_id: userId,
      direction,
      bytes
    });
  } catch (err) {
    console.error('记录带宽失败:', err);
  }
}

/**
 * 获取当月带宽使用统计
 * @param {string} userId - 可选，不指定则所有用户合计
 * @returns {Promise<{uploadBytes: number, downloadBytes: number, totalBytes: number, percentUsed: number}>}
 */
export async function getMonthlyBandwidth(userId = null) {
  let query = supabase
    .from('bandwidth_log')
    .select('direction, bytes')
    .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString());

  if (userId) {
    query = query.eq('user_id', userId);
  }

  const { data, error } = await query;
  if (error) throw error;

  const FREE_BANDWIDTH = 5 * 1024 * 1024 * 1024; // 5 GB

  let uploadBytes = 0;
  let downloadBytes = 0;

  for (const row of (data || [])) {
    if (row.direction === 'upload') uploadBytes += row.bytes;
    else downloadBytes += row.bytes;
  }

  const totalBytes = uploadBytes + downloadBytes;
  return {
    uploadBytes,
    downloadBytes,
    totalBytes,
    percentUsed: (totalBytes / FREE_BANDWIDTH) * 100
  };
}

/**
 * 获取带宽告警状态 (80% 阈值)
 * @returns {Promise<{level: 'ok'|'warn'|'critical', percentUsed: number, message: string}>}
 */
export async function getBandwidthAlert(userId = null) {
  const bandwidth = await getMonthlyBandwidth(userId);

  if (bandwidth.percentUsed >= 95) {
    return {
      level: 'critical',
      percentUsed: bandwidth.percentUsed,
      message: `⚠️ 本月带宽已使用 ${bandwidth.percentUsed.toFixed(1)}%，即将超限！请减少文件传输`
    };
  }
  if (bandwidth.percentUsed >= 80) {
    return {
      level: 'warn',
      percentUsed: bandwidth.percentUsed,
      message: `📊 本月带宽已使用 ${bandwidth.percentUsed.toFixed(1)}%（5GB 限额），请减少大文件传输`
    };
  }
  return { level: 'ok', percentUsed: bandwidth.percentUsed, message: '' };
}

// ===========================================
// 工具函数
// ===========================================

function getFileType(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * 格式化字节数为可读字符串
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

/**
 * 检查文件是否可以上传
 */
export function validateFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: `文件最大 50MB，当前文件 ${formatBytes(file.size)}` };
  }
  if (file.size > RECOMMENDED_FILE_SIZE) {
    return {
      valid: true,
      warning: `文件较大 (${formatBytes(file.size)})，建议压缩到 2MB 以内以节省带宽`
    };
  }
  return { valid: true };
}
