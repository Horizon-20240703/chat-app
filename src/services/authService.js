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
  // CryptoKey 不能直接存 IndexedDB → 导出为 PKCS8 base64
  const { exportPrivateKey } = await import('./encryptionService');
  const base64 = await exportPrivateKey(privateKey);
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
  tx.objectStore('keys').put(base64, 'my-keypair');
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

// ===============================================================
// E2EE 密钥初始化（登录后自动调用，确保每个用户都有密钥对）
// ===============================================================

/**
 * 从 IndexedDB 加载本地存储的私钥（PKCS8 base64 → CryptoKey）
 */
async function loadLocalPrivateKey() {
  try {
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
    const tx = db.transaction('keys', 'readonly');
    const request = tx.objectStore('keys').get('my-keypair');
    const base64 = await new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
    if (!base64 || typeof base64 !== 'string') return null;
    // If it's a corrupted CryptoKey object (old format, not base64), discard
    if (base64.byteLength !== undefined || !base64.match(/^[A-Za-z0-9+/=]+$/)) {
      console.log('[E2EE] Discarding corrupted old-format key data');
      return null;
    }
    // Import back to CryptoKey
    const { importPrivateKey } = await import('./encryptionService');
    return importPrivateKey(base64);
  } catch {
    return null;
  }
}

/**
 * 存储私钥到 IndexedDB（CryptoKey → PKCS8 base64）
 */
async function saveLocalPrivateKey(privateKey) {
  const { exportPrivateKey } = await import('./encryptionService');
  const base64 = await exportPrivateKey(privateKey);
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
  tx.objectStore('keys').put(base64, 'my-keypair');
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 确保当前用户拥有 E2EE 密钥对（登录后自动调用）
 * - 本地有私钥 → 完成
 * - 本地无私钥、Supabase 有公钥 → 警告（本地密钥丢失）
 * - 本地无私钥、Supabase 无公钥 → 首次生成
 *
 * @param {string} userId - 当前用户 ID
 * @returns {Promise<boolean>} 是否成功（或已有）密钥对
 */
export async function ensureE2EEKeys(userId) {
  console.log('[E2EE] ensureE2EEKeys called for', userId?.slice(0, 8));
  try {
    // 1. 检查 Supabase 是否已有公钥（优先，因为这是服务器端的真实状态）
    const { data: remoteKey, error: checkErr } = await supabase
      .from('user_keys')
      .select('public_key')
      .eq('user_id', userId)
      .single();

    if (checkErr && checkErr.code !== 'PGRST116') {
      // PGRST116 = no rows returned, which is expected for new users
      console.log('[E2EE] Supabase check error:', checkErr.message);
    }

    // 2. 本地有私钥，检查是否需要补传公钥
    const localKey = await loadLocalPrivateKey();
    if (localKey) {
      if (remoteKey?.public_key) {
        console.log('[E2EE] Local key + remote key both present, OK');
        return true;
      }
      // 本地有私钥但服务器没有公钥 → 重新生成（旧公钥从未上传，无对话受影响）
      console.log('[E2EE] Local key found but remote missing, regenerating key pair...');
    }

    // 3. 本地无私钥，服务器有公钥 → 删旧公钥，重新生成
    if (remoteKey?.public_key) {
      console.warn('[E2EE] Remote key exists but local lost. Deleting old and regenerating...');
      await supabase.from('user_keys').delete().eq('user_id', userId);
      // fall through to step 4
    }

    // 4. 首次生成密钥对（本地无私钥 + 服务器无公钥）
    console.log('[E2EE] First time, generating new key pair...');
    const { generateKeyPair } = await import('./encryptionService');
    const keyPair = await generateKeyPair();

    // 上传公钥到 Supabase
    const { error: upsertErr } = await supabase.from('user_keys').upsert({
      user_id: userId,
      public_key: keyPair.publicKey,
      updated_at: new Date().toISOString()
    });
    if (upsertErr) {
      console.error('[E2EE] Failed to upload public key:', upsertErr.message);
      throw upsertErr;
    }

    // 存储私钥到 IndexedDB
    await saveLocalPrivateKey(keyPair.privateKey);

    console.log('[E2EE] Key pair generated and registered successfully');
    return true;
  } catch (err) {
    console.error('[E2EE] Initialization failed:', err);
    return false;
  }
}
