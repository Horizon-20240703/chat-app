import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getCurrentSession, onAuthStateChange, signIn, signUp, signOut, ensureE2EEKeys } from '../services/authService';

const AuthContext = createContext(null);

/**
 * 认证上下文 Provider
 * 提供全局认证状态和方法
 */
export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);   // { id, username, email, ... }
  const [profile, setProfile] = useState(null);            // { id, username, display_name, ... }
  const [loading, setLoading] = useState(true);            // 初始加载中

  // 初始化 — 检查是否已有活跃会话
  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        const session = await getCurrentSession();
        if (mounted && session) {
          setCurrentUser(session.user);
          setProfile(session.profile);
          // 等待 E2EE 密钥对就绪（防止与 Chat 竞争生成）
          await ensureE2EEKeys(session.user.id);
        }
      } catch (err) {
        console.error('恢复会话失败:', err);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    init();

    // 监听认证状态变化
    const unsubscribe = onAuthStateChange((user, prof) => {
      if (mounted) {
        setCurrentUser(user);
        setProfile(prof);
        setLoading(false);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // 登录
  const login = useCallback(async (username, password) => {
    setLoading(true);
    try {
      const result = await signIn(username, password);
      setCurrentUser(result.user);
      setProfile(result.profile);
      // 等待 E2EE 密钥对就绪，再放行 UI
      await ensureE2EEKeys(result.user.id);
      return result;
    } finally {
      setLoading(false);
    }
  }, []);

  // 注册
  const register = useCallback(async (username, password) => {
    setLoading(true);
    try {
      const result = await signUp(username, password);
      setCurrentUser(result.user);
      setProfile(result.profile);
      await ensureE2EEKeys(result.user.id);
      return result;
    } finally {
      setLoading(false);
    }
  }, []);

  // 登出
  const logout = useCallback(async () => {
    try {
      await signOut();
    } catch (err) {
      console.error('登出失败:', err);
    } finally {
      setCurrentUser(null);
      setProfile(null);
    }
  }, []);

  const value = {
    currentUser,
    profile,
    loading,
    isAuthenticated: !!currentUser,
    login,
    register,
    logout
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * 使用认证上下文 Hook
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth() must be used within an <AuthProvider>');
  }
  return context;
}

export default AuthContext;
