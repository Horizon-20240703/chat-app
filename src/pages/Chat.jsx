import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { getMessages, sendMessage, markMessagesAsRead } from '../services/messageService';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/Toast';
import { supabase } from '../lib/supabaseClient';
import {
  generateKeyPair, importPublicKey, deriveConversationKey,
  encryptMessage, decryptMessage, storeConversationKey, loadConversationKey,
  getConversationId, exportPublicKey
} from '../services/encryptionService';
import {
  uploadFile, getSignedUrl, getBandwidthAlert, getStorageAlert,
  validateFile, formatBytes, checkAndCleanup
} from '../services/storageService';
import MessageList from '../components/MessageList';
import './Chat.css';

function Chat() {
  const { userId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const toast = useToast();
  const otherUser = location.state?.user;

  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [e2eeReady, setE2eeReady] = useState(false);
  const [alert, setAlert] = useState(null);       // { type: 'bandwidth'|'storage', level, message }
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const channelRef = useRef(null);
  const convKeyRef = useRef(null);                 // 当前对话的 AES 密钥
  const lastMessageCountRef = useRef(0);
  const fileInputRef = useRef(null);

  // ===========================================
  // E2EE 初始化: 设置用户密钥对 + 派生对话密钥
  // ===========================================
  useEffect(() => {
    if (!otherUser) {
      navigate('/users');
      return;
    }

    const init = async () => {
      await setupE2EE();       // 1. 先建立加密密钥
      await loadMessages();    // 2. 再加载消息（此时可解密）
      setupRealtime();         // 3. 订阅新消息
      checkAlerts();
    };
    init();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
    };
  }, [userId]);

  const setupE2EE = async () => {
    try {
      const convId = getConversationId(currentUser.id, otherUser.id);

      // 1. 尝试从 IndexedDB 加载已有的对话密钥
      let convKey = await loadConversationKey(convId);
      if (convKey) {
        convKeyRef.current = convKey;
        setE2eeReady(true);
        return;
      }

      // 2. 确保当前用户有密钥对
      let myKeyPair = await loadMyKeyPair();
      if (!myKeyPair) {
        myKeyPair = await generateAndRegisterKeyPair();
      }

      // 3. 获取对方公钥
      const { data: theirKeys } = await supabase
        .from('user_keys')
        .select('public_key')
        .eq('user_id', otherUser.id)
        .single();

      if (!theirKeys?.public_key) {
        console.warn('对方尚未注册加密密钥，暂不使用 E2EE');
        setE2eeReady(true);  // 仍可正常聊天，只是不加密
        return;
      }

      // 4. 派生对话密钥
      convKey = await deriveConversationKey(myKeyPair.privateKey, theirKeys.public_key);
      convKeyRef.current = convKey;

      // 5. 存储到 IndexedDB (避免重复计算)
      await storeConversationKey(convId, convKey);
      setE2eeReady(true);
    } catch (err) {
      console.error('E2EE 初始化失败，回退到明文模式:', err);
      setE2eeReady(true);  // 降级为明文
    }
  };

  // 从 IndexedDB 加载或生成新的密钥对
  const loadMyKeyPair = async () => {
    try {
      const db = await openLocalDB();
      const tx = db.transaction('keys', 'readonly');
      const request = tx.objectStore('keys').get('my-keypair');
      return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  };

  const generateAndRegisterKeyPair = async () => {
    const { publicKey, privateKey } = await generateKeyPair();

    // 存储私钥到本地 IndexedDB
    await storeMyKeyPair(privateKey);
    // 上传公钥到 Supabase
    await supabase.from('user_keys').upsert({
      user_id: currentUser.id,
      public_key: publicKey,
      updated_at: new Date().toISOString()
    });

    return { publicKey, privateKey };
  };

  const storeMyKeyPair = async (privateKey) => {
    const db = await openLocalDB();
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(privateKey, 'my-keypair');
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  };

  // IndexedDB 辅助
  const openLocalDB = () => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-local-keys', 1);
      request.onupgradeneeded = (e) => {
        if (!e.target.result.objectStoreNames.contains('keys')) {
          e.target.result.createObjectStore('keys');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };

  // ===========================================
  // 带宽/存储告警检查
  // ===========================================
  const checkAlerts = async () => {
    try {
      const [bwAlert, stAlert] = await Promise.all([
        getBandwidthAlert(),
        getStorageAlert()
      ]);

      if (bwAlert.level !== 'ok') {
        setAlert({ type: 'bandwidth', ...bwAlert });
      } else if (stAlert.level !== 'ok') {
        setAlert({ type: 'storage', ...stAlert });
      } else {
        setAlert(null);
      }
    } catch (err) {
      console.error('告警检查失败:', err);
    }
  };

  // ===========================================
  // Supabase Realtime 订阅
  // ===========================================
  const setupRealtime = () => {
    const channel = supabase
      .channel(`chat-${currentUser.id}-${otherUser.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `sender_id=eq.${otherUser.id}`
      }, async (payload) => {
        let msg = payload.new;

        // E2EE 解密
        if (convKeyRef.current && msg.content_type === 'text') {
          try {
            msg = { ...msg, content: await decryptMessage(msg.content, convKeyRef.current) };
          } catch { /* 明文消息或解密失败，保持原样 */ }
        }

        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
        markMessagesAsRead(currentUser.id, otherUser.id).catch(() => {});
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log(`✅ Realtime 已连接 (E2EE: ${!!convKeyRef.current})`);
        }
      });

    channelRef.current = channel;
  };

  // 30 秒静默刷新（同步已读状态等）
  useEffect(() => {
    if (!otherUser) return;
    const refreshInterval = setInterval(async () => {
      try {
        const msgs = await getMessages(currentUser.id, otherUser.id);
        // 解密
        const decrypted = await decryptMessages(msgs);
        setMessages(prev => {
          if (decrypted.length !== prev.length) return decrypted;
          const hasReadChanges = decrypted.some((m, i) =>
            m.is_read !== (prev[i]?.is_read ?? false)
          );
          return hasReadChanges ? decrypted : prev;
        });
      } catch { /* 静默 */ }
    }, 30000);
    return () => clearInterval(refreshInterval);
  }, [userId]);

  // 自滚动
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    if (isAtBottom || messages.length > lastMessageCountRef.current) {
      scrollToBottom();
    }
    lastMessageCountRef.current = messages.length;
  }, [messages]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 200;
      setShowScrollBtn(!nearBottom);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // ===========================================
  // 消息加载 + 解密
  // ===========================================
  const loadMessages = async () => {
    try {
      const msgs = await getMessages(currentUser.id, otherUser.id);
      const decrypted = await decryptMessages(msgs);
      setMessages(decrypted);
      await markMessagesAsRead(currentUser.id, otherUser.id);
    } catch (err) {
      console.error('获取消息失败:', err);
    } finally {
      setLoading(false);
    }
  };

  const decryptMessages = async (msgs) => {
    if (!convKeyRef.current) return msgs;
    return Promise.all(msgs.map(async (msg) => {
      if (msg.content_type === 'text' && msg.content) {
        try {
          return { ...msg, content: await decryptMessage(msg.content, convKeyRef.current) };
        } catch {
          return msg; // 明文或旧格式，保持原样
        }
      }
      return msg;
    }));
  };

  // ===========================================
  // 发送文本消息 (E2EE)
  // ===========================================
  const handleSend = async (e) => {
    e?.preventDefault();
    const trimmed = newMessage.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setNewMessage('');

    // 乐观更新：立即显示（本地明文）
    const tempId = 'temp-' + Date.now();
    const optimisticMsg = {
      id: tempId,
      sender_id: currentUser.id,
      receiver_id: otherUser.id,
      content: trimmed,
      content_type: 'text',
      is_read: false,
      created_at: new Date().toISOString()
    };

    try {
      // E2EE 加密
      let content = trimmed;
      if (convKeyRef.current) {
        content = await encryptMessage(trimmed, convKeyRef.current);
      }

      setMessages(prev => [...prev, optimisticMsg]);

      const sent = await sendMessage(currentUser.id, otherUser.id, content, 'text');

      // 替换临时消息为真实消息
      setMessages(prev => prev.map(m => m.id === tempId ? { ...sent, content: trimmed } : m));

      await checkAlerts();
    } catch (err) {
      console.error('发送消息失败:', err);
      // 移除失败的消息
      setMessages(prev => prev.filter(m => m.id !== tempId));
      setNewMessage(trimmed); // 恢复输入
    } finally {
      setSending(false);
    }
  };

  // ===========================================
  // 文件上传
  // ===========================================
  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await processFile(file);
  };

  const processFile = async (file) => {
    const validation = validateFile(file);
    if (!validation.valid) {
      toast.showToast(validation.error, 'error');
      return;
    }

    // 有警告时弹出确认框，确认后继续上传
    const doUpload = async () => {
      setUploading(true);
      try {
        const placeholder = await sendMessage(
          currentUser.id, otherUser.id,
          `[上传中: ${file.name}...]`,
          getFileContentType(file.type)
        );
        const result = await uploadFile(file, currentUser.id, placeholder.id);
        await supabase.from('messages')
          .update({ content: result.dataUrl })
          .eq('id', placeholder.id);
        await loadMessages();
        await checkAlerts();
        const cleanup = await checkAndCleanup(currentUser.id);
        if (cleanup.cleaned) {
          toast.showToast(`自动清理: 释放 ${formatBytes(cleanup.freed)}`, 'info');
        }
      } catch (err) {
        console.error('文件上传失败:', err);
        toast.showToast('文件上传失败: ' + (err.message || '未知错误'), 'error');
      } finally {
        setUploading(false);
      }
    };

    if (validation.warning) {
      toast.showConfirm(`${validation.warning}\n\n是否继续上传？`, doUpload);
    } else {
      await doUpload();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  const handleBack = () => navigate('/users');

  return (
    <div className="chat-container">
      {/* ======== 告警横幅 ======== */}
      {alert && (
        <div className={`alert-banner alert-${alert.level}`}>
          <span className="alert-icon">{alert.type === 'bandwidth' ? '📊' : '💾'}</span>
          <span className="alert-text">{alert.message}</span>
          <button className="alert-dismiss" onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      {/* ======== 头部 ======== */}
      <div className="chat-header">
        <button onClick={handleBack} className="back-btn" title="返回用户列表">
          ← 返回
        </button>
        <div className="chat-user-info">
          <div className="chat-user-avatar">
            {otherUser?.username?.charAt(0).toUpperCase()}
          </div>
          <div className="chat-user-details">
            <span className="chat-user-name">{otherUser?.username}</span>
            <span className="chat-user-status">
              {e2eeReady && (
                <span className="e2ee-badge" title="端到端加密已启用">
                  🔒 E2EE
                </span>
              )}
            </span>
          </div>
        </div>
      </div>

      {/* ======== 消息区域 ======== */}
      <div
        className={`chat-messages ${dragOver ? 'drag-over' : ''}`}
        ref={messagesContainerRef}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {loading ? (
          <div className="skeleton-chat">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className={`skeleton-message ${i % 2 === 0 ? 'self' : 'other'}`}>
                <div className="skeleton-bubble" style={{ width: `${40 + Math.random() * 40}%` }} />
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">💬</span>
            <p>暂无消息</p>
            <p className="empty-hint">发送一条消息或拖拽文件开始聊天</p>
          </div>
        ) : (
          <MessageList
            messages={messages}
            currentUserId={currentUser.id}
            otherUser={otherUser}
          />
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* ======== 回到底部按钮 ======== */}
      {showScrollBtn && (
        <button onClick={scrollToBottom} className="scroll-bottom-btn" title="回到底部">
          ↓
        </button>
      )}

      {/* ======== 输入区域 ======== */}
      <form className="chat-input-form" onSubmit={handleSend}>
        <button
          type="button"
          className="attach-btn"
          title="发送文件/图片"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || sending}
        >
          {uploading ? '⏳' : '📎'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="file-input-hidden"
          onChange={handleFileSelect}
          accept="image/*,video/*,.pdf,.zip,.txt"
        />
        <textarea
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={uploading ? '文件上传中...' : '输入消息... (Enter 发送, Shift+Enter 换行)'}
          disabled={sending || uploading}
          rows={1}
          className="chat-input"
        />
        <button type="submit" disabled={sending || uploading || !newMessage.trim()}>
          {sending ? '...' : '发送'}
        </button>
      </form>
    </div>
  );
}

function getFileContentType(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

export default Chat;
