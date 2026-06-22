import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import Login from './pages/Login';
import UserList from './pages/UserList';
import Chat from './pages/Chat';
import './App.css';

function AppRoutes() {
  const { isAuthenticated, loading } = useAuth();

  // 初始加载中，显示加载状态
  if (loading) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner" />
        <p>加载中...</p>
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          isAuthenticated ? <Navigate to="/users" replace /> : <Login />
        }
      />
      <Route
        path="/users"
        element={
          isAuthenticated ? <UserList /> : <Navigate to="/login" replace />
        }
      />
      <Route
        path="/chat/:userId"
        element={
          isAuthenticated ? <Chat /> : <Navigate to="/login" replace />
        }
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

function AppWrapper() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <Router>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </Router>
      </ToastProvider>
    </ErrorBoundary>
  );
}

export default AppWrapper;
