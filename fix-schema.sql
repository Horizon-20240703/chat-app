-- ===============================================================
-- 修复脚本: 强制清理旧表，重建全部 v2 表结构
-- 在 Supabase SQL Editor 中执行
-- ===============================================================

-- Step 1: 先看当前有哪些表
SELECT tablename FROM pg_tables WHERE schemaname = 'public';

-- Step 2: 强制删除所有旧表（直接 DROP，不用动态 SQL）
DROP TABLE IF EXISTS bandwidth_log CASCADE;
DROP TABLE IF EXISTS file_attachments CASCADE;
DROP TABLE IF EXISTS user_keys CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS users CASCADE;  -- v1 旧表

-- Step 3: 确认全部删除
SELECT tablename FROM pg_tables WHERE schemaname = 'public';

-- Step 4: 创建 profiles 表
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  status TEXT DEFAULT 'offline',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 5: 创建 messages 表
CREATE TABLE messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  content_type TEXT DEFAULT 'text',
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 6: 创建 user_keys 表
CREATE TABLE user_keys (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 7: 创建 file_attachments 表
CREATE TABLE file_attachments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  mime_type TEXT,
  file_size BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 8: 创建 bandwidth_log 表
CREATE TABLE bandwidth_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
  bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 9: 创建索引
CREATE INDEX idx_messages_sender ON messages(sender_id);
CREATE INDEX idx_messages_receiver ON messages(receiver_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_profiles_username ON profiles(username);
CREATE INDEX idx_file_attachments_message ON file_attachments(message_id);
CREATE INDEX idx_file_attachments_created ON file_attachments(created_at);
CREATE INDEX idx_bandwidth_log_user ON bandwidth_log(user_id);
CREATE INDEX idx_bandwidth_log_created ON bandwidth_log(created_at);

-- Step 10: 启用 RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bandwidth_log ENABLE ROW LEVEL SECURITY;

-- Step 11: RLS 策略
CREATE POLICY "profiles_select_all" ON profiles FOR SELECT USING (true);
CREATE POLICY "profiles_insert_own" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "messages_select_participants" ON messages FOR SELECT USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY "messages_insert_sender" ON messages FOR INSERT WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "messages_update_receiver" ON messages FOR UPDATE USING (auth.uid() = receiver_id);
CREATE POLICY "messages_delete_sender" ON messages FOR DELETE USING (auth.uid() = sender_id);

CREATE POLICY "user_keys_select_all" ON user_keys FOR SELECT USING (true);
CREATE POLICY "user_keys_insert_own" ON user_keys FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "user_keys_update_own" ON user_keys FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "user_keys_delete_own" ON user_keys FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "file_attachments_select" ON file_attachments FOR SELECT USING (
  EXISTS (SELECT 1 FROM messages m WHERE m.id = file_attachments.message_id AND (m.sender_id = auth.uid() OR m.receiver_id = auth.uid()))
);
CREATE POLICY "file_attachments_insert" ON file_attachments FOR INSERT WITH CHECK (auth.uid() = uploader_id);

CREATE POLICY "bandwidth_log_select" ON bandwidth_log FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "bandwidth_log_insert" ON bandwidth_log FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Step 12: 视图
CREATE OR REPLACE VIEW monthly_bandwidth AS
SELECT user_id, direction, SUM(bytes) AS total_bytes, DATE_TRUNC('month', created_at) AS month
FROM bandwidth_log WHERE created_at >= DATE_TRUNC('month', NOW())
GROUP BY user_id, direction, DATE_TRUNC('month', created_at);

CREATE OR REPLACE VIEW storage_usage AS
SELECT uploader_id, COUNT(*) AS file_count, SUM(file_size) AS total_bytes, MAX(created_at) AS last_upload
FROM file_attachments GROUP BY uploader_id;

-- Step 13: 自动清理函数
CREATE OR REPLACE FUNCTION cleanup_oldest_files(target_free_bytes BIGINT DEFAULT 104857600)
RETURNS TABLE(deleted_path TEXT, deleted_size BIGINT, freed_total BIGINT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE freed_so_far BIGINT := 0; rec RECORD;
BEGIN
  freed_total := 0;
  FOR rec IN SELECT id, storage_path, file_size FROM file_attachments ORDER BY created_at ASC LOOP
    IF freed_so_far >= target_free_bytes THEN EXIT; END IF;
    deleted_path := rec.storage_path; deleted_size := rec.file_size;
    freed_so_far := freed_so_far + rec.file_size;
    DELETE FROM file_attachments WHERE id = rec.id;
    freed_total := freed_so_far; RETURN NEXT;
  END LOOP;
END; $$;

-- Step 14: 触发器
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  base_username TEXT; final_username TEXT;
BEGIN
  base_username := SPLIT_PART(NEW.email, '@', 1);
  final_username := base_username;
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = final_username) LOOP
    final_username := base_username || '_' || SUBSTRING(gen_random_uuid()::TEXT, 1, 6);
  END LOOP;
  INSERT INTO public.profiles (id, username) VALUES (NEW.id, final_username) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Step 15: Storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('chat-attachments','chat-attachments',false,52428800,ARRAY['image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm','application/pdf','application/zip','text/plain'])
ON CONFLICT (id) DO NOTHING;

-- Step 16: 最终验证
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
