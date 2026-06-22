// ===============================================================
// 端到端加密服务 (E2EE)
//
// 算法:
//   密钥交换:  ECDH (P-256)
//   密钥派生:  HKDF-SHA256
//   消息加密:  AES-256-GCM (认证加密)
//
// 流程:
//   1. 注册时生成 ECDH 密钥对 → 公钥存 Supabase user_keys
//   2. 打开对话时: ECDH(己方私钥, 对方公钥) → HKDF → AES 密钥
//   3. 发送:   AES-GCM 加密 → base64(IV + ciphertext + authTag)
//   4. 接收:   解码 → AES-GCM 解密 → 明文
//
// 安全属性:
//   - 服务器从未持有私钥或明文
//   - 每个对话独立派生密钥 (Perfect Forward Secrecy 需定期重密钥)
//   - GCM 认证标签阻止篡改
// ===============================================================

const KEY_PAIR_ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' };
const DERIVE_ALGORITHM = { name: 'HKDF', hash: 'SHA-256' };
const ENCRYPT_ALGORITHM = { name: 'AES-GCM', length: 256 };
const HKDF_SALT = new TextEncoder().encode('chat-app-e2ee-v1');
const HKDF_INFO = new TextEncoder().encode('conversation-key');
const IV_LENGTH = 12; // AES-GCM 推荐 96-bit nonce

// ===========================================
// 密钥对管理
// ===========================================

/**
 * 生成用户的 ECDH 密钥对
 * @returns {Promise<{publicKey: string, privateKey: CryptoKey}>}
 */
export async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    KEY_PAIR_ALGORITHM,
    true,  // extractable — 允许导出
    ['deriveBits']
  );
  const publicKeyBase64 = await exportPublicKey(keyPair.publicKey);
  return { publicKey: publicKeyBase64, privateKey: keyPair.privateKey };
}

/**
 * 导出公钥为 Base64 字符串 (SPKI 格式)
 */
export async function exportPublicKey(publicKey) {
  const exported = await crypto.subtle.exportKey('spki', publicKey);
  return arrayBufferToBase64(exported);
}

/**
 * 从 Base64 字符串导入公钥
 */
export async function importPublicKey(base64Key) {
  const buffer = base64ToArrayBuffer(base64Key);
  return crypto.subtle.importKey('spki', buffer, KEY_PAIR_ALGORITHM, true, []);
}

// ===========================================
// 私钥安全存储
// ===========================================

/**
 * 用密码包裹私钥 (PBKDF2 → AES-KW)
 * @param {CryptoKey} privateKey - ECDH 私钥
 * @param {string} password - 用户密码
 * @returns {Promise<{wrappedKey: string, salt: string, iv: string}>}
 */
export async function wrapPrivateKey(privateKey, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await deriveWrappingKey(password, salt);

  const wrapped = await crypto.subtle.wrapKey(
    'pkcs8',
    privateKey,
    wrappingKey,
    { name: 'AES-KW' }
  );

  return {
    wrappedKey: arrayBufferToBase64(wrapped),
    salt: arrayBufferToBase64(salt),
    iv: ''  // AES-KW 不需要 IV
  };
}

/**
 * 用密码解包私钥
 * @param {string} wrappedKeyBase64
 * @param {string} saltBase64
 * @param {string} password
 * @returns {Promise<CryptoKey>}
 */
export async function unwrapPrivateKey(wrappedKeyBase64, saltBase64, password) {
  const wrappedKey = base64ToArrayBuffer(wrappedKeyBase64);
  const salt = base64ToArrayBuffer(saltBase64);
  const wrappingKey = await deriveWrappingKey(password, salt);

  return crypto.subtle.unwrapKey(
    'pkcs8',
    wrappedKey,
    wrappingKey,
    { name: 'AES-KW' },
    KEY_PAIR_ALGORITHM,
    true,
    ['deriveBits']
  );
}

/**
 * 从密码派生包裹密钥 (PBKDF2 → AES-KW)
 */
async function deriveWrappingKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 200000,  // 高迭代次数防暴力破解
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

// ===========================================
// 会话密钥派生
// ===========================================

/**
 * 从己方私钥和对方公钥派生对话 AES 密钥
 * @param {CryptoKey} myPrivateKey
 * @param {string} theirPublicKeyBase64
 * @returns {Promise<CryptoKey>}
 */
export async function deriveConversationKey(myPrivateKey, theirPublicKeyBase64) {
  const theirPublicKey = await importPublicKey(theirPublicKeyBase64);

  // ECDH 计算共享密钥
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirPublicKey },
    myPrivateKey,
    256  // P-256 → 256 bits
  );

  // HKDF 派生 AES 密钥
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    sharedBits,
    'HKDF',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      salt: HKDF_SALT,
      info: HKDF_INFO,
      hash: 'SHA-256'
    },
    hkdfKey,
    ENCRYPT_ALGORITHM,
    false,
    ['encrypt', 'decrypt']
  );
}

// ===========================================
// 消息加密/解密
// ===========================================

/**
 * 加密消息
 * @param {string} plaintext
 * @param {CryptoKey} conversationKey
 * @returns {Promise<string>} Base64(IV + ciphertext + authTag)
 */
export async function encryptMessage(plaintext, conversationKey) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    conversationKey,
    encoded
  );

  // 组合 IV + ciphertext → Base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return arrayBufferToBase64(combined.buffer);
}

/**
 * 解密消息
 * @param {string} encryptedBase64
 * @param {CryptoKey} conversationKey
 * @returns {Promise<string>} 明文
 */
export async function decryptMessage(encryptedBase64, conversationKey) {
  const combined = base64ToArrayBuffer(encryptedBase64);
  const data = new Uint8Array(combined);

  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    conversationKey,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * 检查消息是否为加密格式
 */
export function isEncryptedMessage(content) {
  try {
    const decoded = atob(content);
    return decoded.length > IV_LENGTH;  // 至少有 IV + 数据
  } catch {
    return false;
  }
}

// ===========================================
// 持久化: IndexedDB 密钥存储
// ===========================================

const DB_NAME = 'chat-e2ee-keys';
const DB_VERSION = 1;
const STORE_NAME = 'conversation-keys';

function openKeyDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 存储对话密钥到 IndexedDB
 * @param {string} conversationId - "userA:userB" 格式
 * @param {CryptoKey} key
 */
export async function storeConversationKey(conversationId, key) {
  const exported = await crypto.subtle.exportKey('raw', key);
  const db = await openKeyDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(exported, conversationId);
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 从 IndexedDB 加载对话密钥
 * @param {string} conversationId
 * @returns {Promise<CryptoKey|null>}
 */
export async function loadConversationKey(conversationId) {
  try {
    const db = await openKeyDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(conversationId);
    return new Promise((resolve, reject) => {
      request.onsuccess = async () => {
        if (!request.result) {
          resolve(null);
          return;
        }
        try {
          const key = await crypto.subtle.importKey(
            'raw',
            request.result,
            ENCRYPT_ALGORITHM,
            false,
            ['encrypt', 'decrypt']
          );
          resolve(key);
        } catch {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

/**
 * 生成对话 ID (两个用户 ID 排序后拼接)
 */
export function getConversationId(userId1, userId2) {
  return [userId1, userId2].sort().join(':');
}

// ===========================================
// 工具函数
// ===========================================

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
