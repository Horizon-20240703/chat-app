-- 清掉旧的 E2EE 公钥和残留 IndexedDB 脏数据
-- 在 Supabase SQL Editor 运行: https://supabase.com/dashboard/project/ldglgjcpcohflmcmgobo/sql

DELETE FROM user_keys WHERE user_id IN (
  'c580a7fb-7371-4859-be1c-26b55ec3b2e6',  -- alice
  'e1856f8c-27d2-49bb-b4c3-575a35993de2',  -- bob
  '8312d19b-b362-4108-bd97-fb5bb9bb2032'   -- zhaohong
);
