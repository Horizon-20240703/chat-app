import { createClient } from '@supabase/supabase-js';

// Supabase 客户端单例 — 从环境变量读取配置
const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    '❌ Supabase 配置缺失！\n' +
    '请在项目根目录创建 .env 文件，并设置:\n' +
    '  REACT_APP_SUPABASE_URL=https://your-project.supabase.co\n' +
    '  REACT_APP_SUPABASE_ANON_KEY=your-anon-key'
  );
}

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-key'
);

// 检查是否已正确配置
export function isConfigured() {
  return (
    supabaseUrl &&
    supabaseAnonKey &&
    supabaseUrl !== 'https://placeholder.supabase.co' &&
    supabaseAnonKey !== 'placeholder-key'
  );
}
