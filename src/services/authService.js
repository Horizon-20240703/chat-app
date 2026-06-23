import { supabase } from '../lib/supabaseClient';

// ===============================================================
// 认证服务 — 基于 Supabase Auth
//
// 用户名 → 内部转换为 username@chatapp.test 作为 Supabase Auth 邮箱
// .test 是 RFC 6761 保留的测试 TLD，通过 Supabase 邮箱验证
// 密码由 Supabase Auth 自动安全哈希 (bcrypt)
// 用户档案存储在 public.profiles 表中
// ===============================================================

const EMAIL_DOMAIN = 'chatapp.test';

/**
 * 将用户名转换为内部邮箱
 */
function usernameToEmail(username) {
  return `${username}@${EMAIL_DOMAIN}`;
}

/**
 * 注册新用户 (同时生成 E2EE 密钥对)
 * @param {string} username - 用户名
 * @param {string} password - 密码
 * @returns {Promise<{user: object, profile: object}>}
 */
export async function signUp(username, password) {
  // 1. 检查用户名是否已被占用
  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', username)
    .single();

  if (existing) {
    throw new Error('用户名已存在');
  }

  // 2. 通过 Supabase Auth 注册
  const { data, error } = await supabase.auth.signUp({
    email: usernameToEmail(username),
    password: password,
    options: {
      data: { username }  // 传递给 handle_new_user 触发器
    }
  });

  if (error) throw error;
  if (!data.user) throw new Error('注册失败，请稍后重试');

  // 3. 生成 E2EE 密钥对 (注册时一次生成，终身不变)
  try {
    const { generateKeyPair, exportPublicKey } = await import('./encryptionService');
    const keyPair = await generateKeyPair();
    // 上传公钥
    await supabase.from('user_keys').upsert({
      user_id: data.user.id,
      public_key: keyPair.publicKey,
      updated_at: new Date().toISOString()
    });
    // 存私钥到 IndexedDB
    await storeKeyPair(keyPair.privateKey);
  } catch (e) {
    console.warn('E2EE 密钥生成失败，将跳过加密:', e.message);
  }

  // 4. 等待触发器创建 profile

  if (error) throw error;
  if (!data.user) throw new Error('注册失败，请稍后重试');

  // 3. 等待触发器创建 profile（稍微延迟）
  await new Promise(resolve => setTimeout(resolve, 500));

  // 4. 获取创建的 profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  return { user: data.user, profile };
}

/**
 * 用户登录
 * @param {string} username - 用户名
 * @param {string} password - 密码
 * @returns {Promise<{user: object, profile: object, session: object}>}
 */
export async function signIn(username, password) {
  // 1. 通过 Supabase Auth 登录
  const { data, error } = await supabase.auth.signInWithPassword({
    email: usernameToEmail(username),
    password: password
  });

  if (error) {
    if (error.message.includes('Invalid login')) {
      throw new Error('用户名或密码错误');
    }
    throw error;
  }

  if (!data.user) {
    throw new Error('用户名或密码错误');
  }

  // 2. 获取用户档案
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  return { user: data.user, profile, session: data.session };
}

/**
 * 用户登出
 */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/**
 * 获取当前会话
 * @returns {Promise<{user: object, profile: object} | null>}
 */
export async function getCurrentSession() {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.user) return null;

  // 获取用户档案
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .single();

  // 从邮箱提取用户名
  const username = profile?.username || session.user.email?.split('@')[0] || 'unknown';

  return {
    user: { ...session.user, username },
    profile,
    session
  };
}

/**
 * 监听认证状态变化
 * @param {function} callback - (session, profile) => void
 * @returns {function} unsubscribe
 */
export function onAuthStateChange(callback) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange(
    async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', session.user.id)
          .single();

        const username = profile?.username ||
          session.user.email?.split('@')[0] || 'unknown';

        callback({ ...session.user, username }, profile);
      } else if (event === 'SIGNED_OUT') {
        callback(null, null);
      }
    }
  );

  return () => subscription.unsubscribe();
}

/**
 * 存储 E2EE 私钥到 IndexedDB (仅注册时调用一次)
 */
async function storeKeyPair(privateKey) {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('chat-local-keys', 1);
    req.onupgradeneeded = (e) => {
      if (!e.target.result.objectStoreNames.contains('keys')) {
        e.target.result.createObjectStore('keys');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction('keys', 'readwrite');
  tx.objectStore('keys').put(privateKey, 'my-keypair');
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 检查用户是否已登录
 */
export async function isAuthenticated() {
  const session = await getCurrentSession();
  return !!session;
}
