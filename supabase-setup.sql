-- ===============================================================
-- 通信工具 数据库初始化 SQL (v2.0)
-- 使用 Supabase 内置 Auth，实现安全的密码存储和行级安全
-- ===============================================================
--
-- ⚠️ 执行本脚本前，请先在 Supabase Dashboard 做以下设置:
--    1. Authentication > Settings > Email Auth
--       关闭 "Confirm email" (因为本应用使用 username@chatapp.test 合成邮箱)
--    2. 或者保持开启，但使用真实邮箱注册
--
-- ===============================================================

-- ===============================================================
-- 0. 强制清除所有旧对象，确保安装环境干净
-- ===============================================================
DO $$
DECLARE
  r RECORD;
BEGIN
  -- 删除所有触发器
  FOR r IN (SELECT trigger_name, event_object_table
            FROM information_schema.triggers
            WHERE trigger_schema = 'public') LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.trigger_name, r.event_object_table);
  END LOOP;

  -- 删除 public schema 下所有策略（跳过 storage schema，无权限）
  FOR r IN (SELECT policyname, tablename
            FROM pg_policies
            WHERE schemaname = 'public') LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.policyname, r.tablename);
  END LOOP;

  -- 删除所有视图
  FOR r IN (SELECT table_name FROM information_schema.views WHERE table_schema = 'public') LOOP
    EXECUTE format('DROP VIEW IF EXISTS %I CASCADE', r.table_name);
  END LOOP;

  -- 删除所有函数 (public schema)
  FOR r IN (SELECT routine_name FROM information_schema.routines
            WHERE routine_schema = 'public' AND routine_type = 'FUNCTION') LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %I CASCADE', r.routine_name);
  END LOOP;

  -- 删除所有表 (CASCADE 会连带删除依赖对象)
  FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.tablename);
  END LOOP;
END $$;

-- 删除 auth.users 上的旧触发器
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS handle_new_user();

-- ===============================================================

-- 1. 创建用户档案表 (profiles)
--    关联 Supabase Auth 的 auth.users 表
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  status TEXT DEFAULT 'offline',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 创建消息表
--    encrypted_content: base64 编码的加密消息体 (为 E2EE Phase 3 预留)
--    content_type: 消息类型 (text / image / file)
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,                          -- 消息内容 (Phase 3 后改为密文)
  content_type TEXT DEFAULT 'text',
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 创建公钥目录表 (为 E2EE Phase 3 预留)
CREATE TABLE IF NOT EXISTS user_keys (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 启用 Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_keys ENABLE ROW LEVEL SECURITY;

-- 5. RLS 策略 — profiles 表
--    所有人可读取档案
CREATE POLICY "profiles_select_all" ON profiles
  FOR SELECT USING (true);

--    仅本人可插入自己的档案
CREATE POLICY "profiles_insert_own" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

--    仅本人可更新自己的档案
CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE USING (auth.uid() = id);

-- 6. RLS 策略 — messages 表
--    仅对话双方可读取消息
CREATE POLICY "messages_select_participants" ON messages
  FOR SELECT USING (
    auth.uid() = sender_id OR auth.uid() = receiver_id
  );

--    仅发送者可插入消息
CREATE POLICY "messages_insert_sender" ON messages
  FOR INSERT WITH CHECK (auth.uid() = sender_id);

--    仅接收者可标记消息为已读
CREATE POLICY "messages_update_receiver" ON messages
  FOR UPDATE USING (auth.uid() = receiver_id)
  WITH CHECK (auth.uid() = receiver_id AND is_read = true);

--    发送者可更新自己发送的消息（如文件上传后替换 URL）
CREATE POLICY "messages_update_sender" ON messages
  FOR UPDATE USING (auth.uid() = sender_id)
  WITH CHECK (auth.uid() = sender_id);

--    发送者可以删除自己的消息
CREATE POLICY "messages_delete_sender" ON messages
  FOR DELETE USING (auth.uid() = sender_id);

-- 7. RLS 策略 — user_keys 表
--    所有人可读取公钥 (E2EE 需要)
CREATE POLICY "user_keys_select_all" ON user_keys
  FOR SELECT USING (true);

--    仅本人可插入/更新自己的公钥
CREATE POLICY "user_keys_insert_own" ON user_keys
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_keys_update_own" ON user_keys
  FOR UPDATE USING (auth.uid() = user_id);

-- 8. 创建文件附件表
--    追踪上传到 Supabase Storage 的文件，用于空间管理和自动清理
CREATE TABLE IF NOT EXISTS file_attachments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,              -- Supabase Storage 中的路径
  file_name TEXT NOT NULL,                 -- 原始文件名
  file_type TEXT NOT NULL,                 -- image / video / file
  mime_type TEXT,                          -- image/png, video/mp4 等
  file_size BIGINT NOT NULL DEFAULT 0,     -- 字节数
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. 创建带宽使用日志表
--     客户端每次上传/下载后写入，用于月度统计和 80% 告警
CREATE TABLE IF NOT EXISTS bandwidth_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
  bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. 创建索引（所有表的索引集中管理）
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_file_attachments_message ON file_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_file_attachments_created ON file_attachments(created_at);
CREATE INDEX IF NOT EXISTS idx_bandwidth_log_user ON bandwidth_log(user_id);
CREATE INDEX IF NOT EXISTS idx_bandwidth_log_created ON bandwidth_log(created_at);

-- 11. 自动清理函数: 当存储空间不足时，按时间先后删除最旧的文件
--     在 Supabase Dashboard > Storage 中创建 bucket 后，
--     可通过 pg_cron 定期调用此函数
CREATE OR REPLACE FUNCTION cleanup_oldest_files(
  target_free_bytes BIGINT DEFAULT 104857600  -- 默认释放 100MB
)
RETURNS TABLE(deleted_path TEXT, deleted_size BIGINT, freed_total BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  freed_so_far BIGINT := 0;
  rec RECORD;
BEGIN
  freed_total := 0;

  -- 按创建时间升序（最旧的先删），循环删除直到释放足够空间
  FOR rec IN
    SELECT id, storage_path, file_size
    FROM file_attachments
    ORDER BY created_at ASC
  LOOP
    IF freed_so_far >= target_free_bytes THEN
      EXIT;
    END IF;

    deleted_path := rec.storage_path;
    deleted_size := rec.file_size;
    freed_so_far := freed_so_far + rec.file_size;

    -- 删除数据库记录（Storage 中的文件需要客户端或 Storage API 删除）
    DELETE FROM file_attachments WHERE id = rec.id;

    freed_total := freed_so_far;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- 12. 月度带宽统计视图 (用于 80% 告警)
CREATE OR REPLACE VIEW monthly_bandwidth AS
SELECT
  user_id,
  direction,
  SUM(bytes) AS total_bytes,
  DATE_TRUNC('month', created_at) AS month
FROM bandwidth_log
WHERE created_at >= DATE_TRUNC('month', NOW())
GROUP BY user_id, direction, DATE_TRUNC('month', created_at);

-- 13. 存储使用量统计视图
CREATE OR REPLACE VIEW storage_usage AS
SELECT
  uploader_id,
  COUNT(*) AS file_count,
  SUM(file_size) AS total_bytes,
  MAX(created_at) AS last_upload
FROM file_attachments
GROUP BY uploader_id;

-- ===============================================================
-- RLS 策略 (续)
-- ===============================================================

-- 14. 启用新表的 RLS
ALTER TABLE file_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bandwidth_log ENABLE ROW LEVEL SECURITY;

-- file_attachments: 对话参与者可查看关联的文件
CREATE POLICY "file_attachments_select" ON file_attachments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM messages m
      WHERE m.id = file_attachments.message_id
      AND (m.sender_id = auth.uid() OR m.receiver_id = auth.uid())
    )
  );

-- file_attachments: 上传者可插入
CREATE POLICY "file_attachments_insert" ON file_attachments
  FOR INSERT WITH CHECK (auth.uid() = uploader_id);

-- bandwidth_log: 仅本人可查看自己的带宽
CREATE POLICY "bandwidth_log_select" ON bandwidth_log
  FOR SELECT USING (auth.uid() = user_id);

-- bandwidth_log: 本人可写入
CREATE POLICY "bandwidth_log_insert" ON bandwidth_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ===============================================================
-- 15. 创建 Storage Bucket
--     ⚠️ 策略需要在 Supabase Dashboard > Storage 中手动设置（见末尾说明）
-- ===============================================================

-- 创建 chat-attachments bucket（权限不够时静默跳过）
DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES (
    'chat-attachments',
    'chat-attachments',
    false,
    52428800,
    ARRAY[
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm',
      'application/pdf', 'application/zip',
      'text/plain'
    ]
  )
  ON CONFLICT (id) DO UPDATE
  SET file_size_limit = 52428800,
      allowed_mime_types = ARRAY[
        'image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'video/mp4', 'video/webm',
        'application/pdf', 'application/zip',
        'text/plain'
      ];
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE '⚠️  Bucket 创建需在 Dashboard > Storage 中手动操作';
END $$;

-- ===============================================================

-- 16. 触发器: 注册时自动创建 profile
--     从合成邮箱 username@chatapp.test 提取 username，
--     如有冲突则追加 UUID 短后缀去重
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  base_username TEXT;
  final_username TEXT;
BEGIN
  -- 从合成邮箱提取用户名: username@chatapp.test → username
  base_username := SPLIT_PART(NEW.email, '@', 1);
  final_username := base_username;

  -- 如果 username 已被占用，追加 UUID 前 6 位去重
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = final_username) LOOP
    final_username := base_username || '_' || SUBSTRING(gen_random_uuid()::TEXT, 1, 6);
  END LOOP;

  INSERT INTO public.profiles (id, username)
  VALUES (NEW.id, final_username)
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- 创建触发器（仅在未存在时创建）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created') THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION handle_new_user();
  END IF;
END $$;

-- ===============================================================
-- 📋 手动操作: Storage 策略设置
-- ===============================================================
-- 由于 Supabase SQL Editor 无 storage.objects 的 OWNER 权限，
-- Storage 策略需在 Dashboard 中设置。Bucket 已由上方 SQL 自动创建。
--
-- 1. 打开 Supabase Dashboard → Storage
-- 2. 确认 chat-attachments bucket 存在
-- 3. 点击 bucket → Policies
-- 4. 新建 SELECT 策略:
--    名称: "对话参与者可下载"
--    策略: (sender_id = auth.uid()) OR (receiver_id = auth.uid())
--    或使用自定义 SQL:
--    ```
--    bucket_id = 'chat-attachments' AND EXISTS (
--      SELECT 1 FROM file_attachments fa
--      JOIN messages m ON m.id = fa.message_id
--      WHERE fa.storage_path = storage.objects.name
--      AND (m.sender_id = auth.uid() OR m.receiver_id = auth.uid())
--    )
--    ```
-- 5. 新建 INSERT 策略:
--    名称: "认证用户可上传"
--    策略: bucket_id = 'chat-attachments' AND auth.role() = 'authenticated'
--
-- ===============================================================
-- ✅ SQL 初始化完成
-- ===============================================================
