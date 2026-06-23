-- ===============================================================
-- 修复 Realtime 消息延迟问题
-- 在 Supabase SQL Editor 中运行此脚本:
--   https://supabase.com/dashboard/project/ldglgjcpcohflmcmgobo/sql
-- ===============================================================

-- 1. 将 messages 表加入 Realtime 发布通道（关键！）
--    没有这一步，WebSocket 永远收不到消息推送
ALTER PUBLICATION supabase_realtime ADD TABLE messages;

-- 2. 设置 REPLICA IDENTITY FULL
--    确保 WAL 日志包含完整行数据（目前只订阅 INSERT 所以不强制，
--    但推荐设置，避免未来订阅 UPDATE/DELETE 时丢数据）
ALTER TABLE messages REPLICA IDENTITY FULL;

-- 3. 验证配置
SELECT
  schemaname,
  tablename,
  pubname
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND tablename = 'messages';
-- 应该返回一行：public | messages | supabase_realtime

-- 4. 确认 REPLICA IDENTITY
SELECT relreplident
FROM pg_class
WHERE relname = 'messages';
-- 'f' = FULL, 说明已生效
