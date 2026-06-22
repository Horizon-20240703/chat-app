import React, { useMemo, useState } from 'react';
import { getSignedUrl } from '../services/storageService';
import './MessageList.css';

/**
 * 判断两条消息是否需要分组显示
 */
function shouldGroupMessages(prevMsg, currMsg) {
  if (!prevMsg || !currMsg) return false;
  if (prevMsg.sender_id !== currMsg.sender_id) return false;
  if (prevMsg.content_type !== currMsg.content_type) return false; // 不同类型不分组
  const prevTime = new Date(prevMsg.created_at).getTime();
  const currTime = new Date(currMsg.created_at).getTime();
  return (currTime - prevTime) < 5 * 60 * 1000;
}

/**
 * 格式化日期分隔线
 */
function formatDateLabel(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  if (msgDate.getTime() === today.getTime()) return '今天';
  if (msgDate.getTime() === yesterday.getTime()) return '昨天';
  if ((today.getTime() - msgDate.getTime()) < 7 * 86400000) return weekDays[date.getDay()];
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ===========================================
// 图片消息组件
// ===========================================
function ImageContent({ src, isSelf }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  if (error) return <div className="media-error">🖼 图片加载失败</div>;

  return (
    <>
      <div className={`image-wrapper ${isSelf ? 'self-image' : 'other-image'}`}>
        {!loaded && <div className="image-placeholder">⏳ 加载中...</div>}
        <img
          src={src}
          alt="图片"
          className={`msg-image ${loaded ? 'loaded' : ''}`}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          onClick={() => setFullscreen(true)}
          loading="lazy"
        />
      </div>
      {fullscreen && (
        <div className="image-fullscreen" onClick={() => setFullscreen(false)}>
          <img src={src} alt="图片全屏" />
          <button className="fullscreen-close">✕</button>
        </div>
      )}
    </>
  );
}

// ===========================================
// 视频消息组件
// ===========================================
function VideoContent({ src }) {
  return (
    <div className="video-wrapper">
      <video controls preload="metadata" className="msg-video">
        <source src={src} />
        您的浏览器不支持视频播放
      </video>
    </div>
  );
}

// ===========================================
// 文件消息组件
// ===========================================
function FileContent({ fileName, src }) {
  const fileExt = (fileName || '').split('.').pop()?.toLowerCase() || '';
  const icon = fileExt === 'pdf' ? '📄' : fileExt === 'zip' ? '📦' : '📎';

  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="file-attachment">
      <span className="file-icon">{icon}</span>
      <span className="file-name">{fileName || '未知文件'}</span>
      <span className="file-download">⬇ 下载</span>
    </a>
  );
}

// ===========================================
// 主组件
// ===========================================
function MessageList({ messages, currentUserId, otherUser }) {
  const processedMessages = useMemo(() => {
    if (!messages || messages.length === 0) return [];

    const result = [];
    let lastDateLabel = '';

    messages.forEach((msg, index) => {
      // 日期分隔线
      const dateLabel = formatDateLabel(msg.created_at);
      if (dateLabel !== lastDateLabel) {
        result.push({ type: 'date', label: dateLabel, id: `date-${dateLabel}-${msg.id}` });
        lastDateLabel = dateLabel;
      }

      const isSelf = msg.sender_id === currentUserId;
      const prevMsg = messages[index - 1];
      const nextMsg = messages[index + 1];
      const isGroupStart = !shouldGroupMessages(prevMsg, msg);
      const isGroupEnd = !shouldGroupMessages(msg, nextMsg);

      result.push({
        type: 'message',
        ...msg,
        isSelf,
        isGroupStart,
        isGroupEnd,
        showAvatar: !isSelf && isGroupStart,
        showTime: true,
        senderInitial: otherUser?.username?.charAt(0)?.toUpperCase() || '?'
      });
    });

    return result;
  }, [messages, currentUserId, otherUser]);

  return (
    <div className="message-list">
      {processedMessages.map((item) => {
        if (item.type === 'date') {
          return (
            <div key={item.id} className="date-separator">
              <span>{item.label}</span>
            </div>
          );
        }

        const isMedia = item.content_type === 'image' || item.content_type === 'video';
        const isFile = item.content_type === 'file';
        const isText = item.content_type === 'text' || !item.content_type;

        return (
          <div
            key={item.id}
            className={`message-row ${item.isSelf ? 'self' : 'other'} ${item.isGroupStart ? 'group-start' : ''} ${item.isGroupEnd ? 'group-end' : ''} ${isMedia ? 'media-row' : ''}`}
          >
            {/* 对方头像 */}
            {!item.isSelf && item.showAvatar && (
              <div className="msg-avatar">{item.senderInitial}</div>
            )}
            {!item.isSelf && !item.showAvatar && <div className="msg-avatar-spacer" />}

            <div className={`message-content ${isMedia ? 'media-content' : ''}`}>
              {/* 消息气泡 / 媒体 */}
              {isMedia && item.content_type === 'image' && (
                <ImageContent src={item.content} isSelf={item.isSelf} />
              )}
              {isMedia && item.content_type === 'video' && (
                <VideoContent src={item.content} />
              )}
              {isFile && (
                <FileContent fileName={item.file_name || '文件'} src={item.content} />
              )}
              {isText && (
                <div className={`message-bubble ${item.isSelf ? 'self-bubble' : 'other-bubble'}`}>
                  {item.content}
                </div>
              )}
            </div>

            {/* 已读状态 — 仅自己的文本消息 */}
            {item.isSelf && item.isGroupEnd && isText && (
              <div className="msg-status">
                {item.is_read ? (
                  <span className="status-read" title="已读">✓✓</span>
                ) : (
                  <span className="status-sent" title="已发送">✓</span>
                )}
              </div>
            )}

            {!item.isSelf && <div className="message-spacer" />}
          </div>
        );
      })}
    </div>
  );
}

export default MessageList;
