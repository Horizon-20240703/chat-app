-- ===============================================================
-- 修复: 添加 user_keys 的 DELETE 策略
-- 原 schema 缺少此策略，导致客户端无法删除自己的旧公钥
-- 在 Supabase SQL Editor 运行: https://supabase.com/dashboard/project/ldglgjcpcohflmcmgobo/sql
-- ===============================================================

-- user_keys: 允许用户删除自己的公钥（密钥对重新生成时使用）
CREATE POLICY "user_keys_delete_own" ON user_keys
  FOR DELETE USING (auth.uid() = user_id);
