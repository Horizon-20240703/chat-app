import React, { useState, useCallback, createContext, useContext } from 'react';
import './Toast.css';

const ToastContext = createContext(null);

/**
 * 轻量级 Toast 通知系统 — 替代 window.alert / window.confirm
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback((message, type = 'info', duration = 4000) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    if (duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);
    }
    return id;
  }, []);

  const showConfirm = useCallback((message, onOk) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, {
      id, message, type: 'confirm',
      onOk: () => { onOk(); setToasts(prev => prev.filter(t => t.id !== id)); },
      onCancel: () => setToasts(prev => prev.filter(t => t.id !== id))
    }]);
  }, []);

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, showConfirm }}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <span className="toast-msg">{t.message}</span>
            {t.type === 'confirm' ? (
              <span className="toast-actions">
                <button onClick={t.onOk}>确认</button>
                <button onClick={t.onCancel}>取消</button>
              </span>
            ) : (
              <button className="toast-close" onClick={() => dismiss(t.id)}>✕</button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
