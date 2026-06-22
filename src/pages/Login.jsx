import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { isConfigured } from '../lib/supabaseClient';
import './Login.css';

function Login() {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();
  const { login, register } = useAuth();

  useEffect(() => {
    setConfigured(isConfigured());
  }, []);

  const getPasswordStrength = (pwd) => {
    if (!pwd) return { level: 0, label: '', color: '' };
    let score = 0;
    if (pwd.length >= 6) score++;
    if (pwd.length >= 10) score++;
    if (/[A-Z]/.test(pwd)) score++;
    if (/[0-9]/.test(pwd)) score++;
    if (/[^A-Za-z0-9]/.test(pwd)) score++;
    const levels = [
      { level: 0, label: '', color: '' },
      { level: 1, label: '弱', color: '#e74c3c' },
      { level: 2, label: '一般', color: '#f39c12' },
      { level: 3, label: '好', color: '#2ecc71' },
      { level: 4, label: '强', color: '#27ae60' },
      { level: 5, label: '很强', color: '#27ae60' },
    ];
    return levels[Math.min(score, 5)];
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!configured) {
      setError('请先配置 Supabase 连接！在项目根目录创建 .env 文件');
      return;
    }

    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password) {
      setError('请输入用户名和密码');
      return;
    }

    if (trimmedUsername.length < 3) {
      setError('用户名至少需要 3 个字符');
      return;
    }

    if (password.length < 6) {
      setError('密码至少需要 6 个字符');
      return;
    }

    if (isRegister && password !== confirmPassword) {
      setError('两次密码输入不一致');
      return;
    }

    setSubmitting(true);

    try {
      if (isRegister) {
        await register(trimmedUsername, password);
      } else {
        await login(trimmedUsername, password);
      }
      navigate('/users');
    } catch (err) {
      setError(err.message || '操作失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const strength = getPasswordStrength(password);

  return (
    <div className="login-container">
      <div className="login-box">
        <div className="login-logo">💬</div>
        <h1>{isRegister ? '注册账号' : '欢迎回来'}</h1>
        <p className="login-subtitle">安全即时通讯工具</p>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">用户名</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名（至少 3 个字符）"
              disabled={submitting}
              autoComplete="username"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">密码</label>
            <div className="password-input-wrapper">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码（至少 6 个字符）"
                disabled={submitting}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
              >
                {showPassword ? '🙈' : '👁'}
              </button>
            </div>
            {isRegister && password && (
              <div className="password-strength">
                <div className="strength-bar">
                  {[1, 2, 3, 4, 5].map(i => (
                    <div
                      key={i}
                      className={`strength-segment ${i <= strength.level ? 'active' : ''}`}
                      style={i <= strength.level ? { background: strength.color } : {}}
                    />
                  ))}
                </div>
                <span style={{ color: strength.color }}>{strength.label}</span>
              </div>
            )}
          </div>
          {isRegister && (
            <div className="form-group">
              <label htmlFor="confirmPassword">确认密码</label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="请再次输入密码"
                disabled={submitting}
                autoComplete="new-password"
              />
            </div>
          )}
          {error && <div className="error-message">{error}</div>}
          <button type="submit" disabled={submitting}>
            {submitting ? (
              <span className="btn-loading">
                <span className="spinner" /> 处理中...
              </span>
            ) : (isRegister ? '注册' : '登录')}
          </button>
        </form>
        <div className="toggle-mode">
          <button type="button" onClick={() => { setIsRegister(!isRegister); setError(''); }}>
            {isRegister ? '已有账号？去登录' : '没有账号？去注册'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Login;
