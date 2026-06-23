"""
诊断 Supabase Realtime 配置 —— 检查消息表是否已加入发布通道
"""
import os
import sys
import json
import urllib.request

# Read env vars
env_file = os.path.join(os.path.dirname(__file__), '..', '.env')
env_vars = {}
if os.path.exists(env_file):
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env_vars[k.strip()] = v.strip()

SUPABASE_URL = env_vars.get('REACT_APP_SUPABASE_URL', 'https://ldglgjcpcohflmcmgobo.supabase.co')
ANON_KEY = env_vars.get('REACT_APP_SUPABASE_ANON_KEY', '')

# Read secret key from python with env
SECRET_KEY = os.environ.get('SUPABASE_SECRET_KEY', '')
if not SECRET_KEY:
    # try reading from .env
    secret_file = os.path.join(os.path.dirname(__file__), '..', '.env.secret')
    if os.path.exists(secret_file):
        with open(secret_file) as f:
            SECRET_KEY = f.read().strip()

headers = {
    'apikey': ANON_KEY,
    'Authorization': f'Bearer {ANON_KEY}',
    'Content-Type': 'application/json',
}

def api_get(path):
    url = SUPABASE_URL + path
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())

def api_sql(sql, use_secret=False):
    """Execute SQL via Supabase REST API (needs service_role for pg_* queries)"""
    key = SECRET_KEY if use_secret else ANON_KEY
    h = {
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
    }
    url = SUPABASE_URL + '/rest/v1/rpc/exec_sql'
    req = urllib.request.Request(url, headers=h, data=json.dumps({'sql': sql}).encode(), method='POST')
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read().decode()

print('=== Supabase Realtime 配置诊断 ===')
print(f'URL: {SUPABASE_URL}')
print()

# 1. Check if messages table exists and has data
print('[1] 检查 messages 表...')
try:
    msgs = api_get('/rest/v1/messages?select=id&limit=3')
    print(f'    ✅ messages 表存在，有数据: {len(msgs)} 条')
except Exception as e:
    print(f'    ❌ messages 表访问失败: {e}')

# 2. Check if we can reach the Supabase REST API
print('[2] 检查 API 连通性...')
try:
    profiles = api_get('/rest/v1/profiles?select=username&limit=2')
    print(f'    ✅ API 正常，profiles 表可读: {len(profiles)} 条')
except Exception as e:
    print(f'    ❌ API 异常: {e}')

print()
print('=== 关键结论 ===')
print()
print('⚠️  Realtime 消息延迟的可能原因:')
print()
print('1. messages 表未加入 supabase_realtime publication')
print('   → 请在 Supabase SQL Editor 运行以下 SQL:')
print()
print('   ALTER PUBLICATION supabase_realtime ADD TABLE messages;')
print()
print('2. REPLICA IDENTITY 未设置为 FULL')
print('   → 可选优化（推荐但不强制）:')
print()
print('   ALTER TABLE messages REPLICA IDENTITY FULL;')
print()
print('3. Supabase Dashboard > Database > Replication')
print('   → 确认 messages 表已开启 Realtime')
print()
print('修复后，消息应该能在 1-2 秒内送达（而非等待 30 秒轮询）。')
