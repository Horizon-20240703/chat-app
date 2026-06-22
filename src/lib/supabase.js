/**
 * @deprecated 此文件已拆分，请直接使用新模块:
 *   - src/lib/supabaseClient.js   → Supabase 客户端
 *   - src/services/authService.js → 认证
 *   - src/services/userService.js → 用户
 *   - src/services/messageService.js → 消息
 *
 * 保留此文件仅为向后兼容性。
 */

// 重新导出
export { supabase, isConfigured } from './supabaseClient';

// 向后兼容: 从服务层重新导出
export {
  signIn as loginUser,
  signUp as registerUser,
  signOut,
  getCurrentSession,
  onAuthStateChange,
} from '../services/authService';

export {
  getUsers,
  getCurrentUserProfile as getCurrentUser,
  searchUsers,
  updateProfile,
} from '../services/userService';

export {
  getMessages,
  sendMessage,
  markMessagesAsRead,
  getUnreadCount,
  deleteMessage,
} from '../services/messageService';
