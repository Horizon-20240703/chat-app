import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getUsers } from '../services/userService';
import { getUnreadCountBySender } from '../services/messageService';
import './UserList.css';

function UserList() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [unreadCounts, setUnreadCounts] = useState({});
  const navigate = useNavigate();
  const { currentUser, logout } = useAuth();

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      setLoading(true);
      setError('');
      const allUsers = await getUsers();
      const otherUsers = allUsers.filter(u => u.id !== currentUser.id);
      setUsers(otherUsers);

      // 加载未读消息计数
      try {
        const counts = await getUnreadCountBySender(currentUser.id);
        setUnreadCounts(counts);
      } catch (err) {
        console.error('获取未读计数失败:', err);
      }
    } catch (err) {
      setError('获取用户列表失败');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleUserClick = (user) => {
    navigate(`/chat/${user.id}`, { state: { user } });
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  // 格式化时间
  const formatTime = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins}分钟前`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}小时前`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}天前`;
    return date.toLocaleDateString();
  };

  // 搜索过滤
  const filteredUsers = users.filter(u =>
    !searchQuery.trim() ||
    u.username.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="user-list-container">
      <div className="user-list-header">
        <div className="header-left">
          <h2>消息</h2>
        </div>
        <div className="header-right">
          <span className="current-username">{currentUser.username}</span>
          <button onClick={handleLogout} className="logout-btn">退出</button>
        </div>
      </div>

      <div className="search-bar">
        <span className="search-icon">🔍</span>
        <input
          type="text"
          placeholder="搜索用户..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button className="search-clear" onClick={() => setSearchQuery('')}>✕</button>
        )}
      </div>

      <div className="user-list-content">
        {loading ? (
          <div className="skeleton-list">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="skeleton-user-item">
                <div className="skeleton-avatar" />
                <div className="skeleton-text">
                  <div className="skeleton-line skeleton-name" />
                  <div className="skeleton-line skeleton-time" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="error-state">
            <span className="error-icon">⚠️</span>
            <p>{error}</p>
            <button onClick={loadUsers} className="retry-btn">重试</button>
          </div>
        ) : filteredUsers.length === 0 && searchQuery ? (
          <div className="empty-state">
            <span className="empty-icon">🔍</span>
            <p>未找到匹配 "{searchQuery}" 的用户</p>
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">👥</span>
            <p>暂无其他用户</p>
            <p className="empty-hint">邀请朋友注册即可开始聊天</p>
          </div>
        ) : (
          <div className="user-list">
            {filteredUsers.map(user => {
              const unread = unreadCounts[user.id] || 0;
              return (
                <div
                  key={user.id}
                  className={`user-item ${unread > 0 ? 'has-unread' : ''}`}
                  onClick={() => handleUserClick(user)}
                >
                  <div className="user-avatar">
                    {user.username.charAt(0).toUpperCase()}
                    <span className={`online-dot ${user.status === 'online' ? 'online' : ''}`} />
                  </div>
                  <div className="user-details">
                    <div className="user-name-row">
                      <span className="user-name">{user.username}</span>
                      {unread > 0 && (
                        <span className="unread-badge">{unread > 99 ? '99+' : unread}</span>
                      )}
                    </div>
                    <div className="user-meta">
                      <span className="user-time">{formatTime(user.created_at)}加入</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <button onClick={loadUsers} className="refresh-btn" title="刷新列表">
        🔄 刷新
      </button>
    </div>
  );
}

export default UserList;
