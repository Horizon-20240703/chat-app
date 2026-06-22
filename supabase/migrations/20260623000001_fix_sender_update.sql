-- 允许发送者更新自己发送的消息（文件上传后替换占位内容）
CREATE POLICY "messages_update_sender" ON messages
  FOR UPDATE USING (auth.uid() = sender_id)
  WITH CHECK (auth.uid() = sender_id);
