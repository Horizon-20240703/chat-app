"""
从 Supabase 获取聊天记录 —— 命令行 + Python 模块双用

命令行用法:
  python get_messages.py                         # 列出所有用户
  python get_messages.py alice bob                # 获取对话 (密文)
  python get_messages.py alice bob --key key.txt  # 获取对话 (解密)
  python get_messages.py --all                    # 获取所有消息

模块导入用法:
  from get_messages import get_messages, get_users
  msgs = get_messages('alice', 'bob')
  msgs = get_messages('alice', 'bob', key_path='e2ee_private_key.txt')  # 解密

导出私钥: 浏览器 F12 → 粘贴 export_key.html 中的代码 → 下载 e2ee_private_key.txt

依赖: pip install cryptography  (仅解密模式需要)
"""

import os
import sys
import io
import base64
import json as json_module
import urllib.request
import urllib.parse

if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

SUPABASE_URL = os.environ.get('SUPABASE_URL', 'YOUR_SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', 'YOUR_SUPABASE_SERVICE_ROLE_KEY')

# ---- Supabase API ----

def api_request(path):
    url = SUPABASE_URL + path
    req = urllib.request.Request(url, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY
    })
    with urllib.request.urlopen(req) as resp:
        return json_module.loads(resp.read())

def get_users():
    return api_request('/rest/v1/profiles?select=id,username')

def get_user_by_name(username):
    encoded = urllib.parse.quote(username, safe='')
    users = api_request(f'/rest/v1/profiles?select=id,username&username=eq.{encoded}')
    return users[0] if users else None

def get_user_key(user_id):
    keys = api_request(f'/rest/v1/user_keys?select=public_key&user_id=eq.{user_id}')
    return keys[0]['public_key'] if keys else None

def get_messages(user_a, user_b):
    if isinstance(user_a, str):
        user_a = get_user_by_name(user_a)
    if isinstance(user_b, str):
        user_b = get_user_by_name(user_b)
    if not user_a or not user_b:
        raise ValueError('用户不存在')
    a, b = user_a['id'], user_b['id']
    inner = f'and(sender_id.eq.{a},receiver_id.eq.{b}),and(sender_id.eq.{b},receiver_id.eq.{a})'
    inner_encoded = urllib.parse.quote(inner, safe='')
    path = f'/rest/v1/messages?select=id,content,content_type,sender_id,created_at&or=({inner_encoded})&order=created_at.asc'
    return api_request(path), user_a, user_b

def get_all_messages():
    return api_request('/rest/v1/messages?select=content,content_type,sender_id,created_at&order=created_at.asc')

# ---- E2EE 解密 ----

def is_encrypted(content):
    """判断 content 是否为 E2EE base64 密文（非 data: URL）"""
    if not content or content.startswith('data:'):
        return False
    try:
        raw = base64.b64decode(content)
        return len(raw) > 12  # 至少有 IV(12) + ciphertext + authTag(16)
    except Exception:
        return False

def decrypt_messages(messages, my_private_key_pkcs8_b64, their_public_key_b64):
    """解密消息列表，无法解密的保留原样"""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.serialization import load_der_private_key

    # 1. 导入对方的公钥 (SPKI DER 格式，与 JS crypto.subtle.exportKey('spki') 一致)
    their_pub_bytes = base64.b64decode(their_public_key_b64)
    from cryptography.hazmat.primitives.serialization import load_der_public_key
    their_pub = load_der_public_key(their_pub_bytes)

    # 2. 导入自己的私钥 (PKCS8 DER)
    my_priv_bytes = base64.b64decode(my_private_key_pkcs8_b64)
    my_priv = load_der_private_key(my_priv_bytes, password=None)

    # 3. ECDH 共享密钥
    shared = my_priv.exchange(ec.ECDH(), their_pub)

    # 4. HKDF 派生 AES 密钥
    hkdf_salt = b'chat-app-e2ee-v1'
    hkdf_info = b'conversation-key'
    aes_key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=hkdf_salt,
        info=hkdf_info,
    ).derive(shared)

    aesgcm = AESGCM(aes_key)

    # 5. 解密每条消息
    result = []
    for m in messages:
        content = m.get('content', '')
        if not is_encrypted(content):
            result.append(m)
            continue
        try:
            raw = base64.b64decode(content)
            iv = raw[:12]
            ciphertext = raw[12:]
            plaintext = aesgcm.decrypt(iv, ciphertext, None)
            result.append({**m, 'content': plaintext.decode('utf-8')})
        except Exception:
            result.append(m)  # 解密失败，保留原样
    return result

# ---- 主程序 ----

if __name__ == '__main__':
    args = sys.argv[1:]
    use_json = '--json' in args
    key_path = None

    # 解析 --key 参数
    for i, a in enumerate(args):
        if a == '--key' and i + 1 < len(args):
            key_path = args[i + 1]
            args.pop(i + 1)
            args.pop(i)
            break

    args = [a for a in args if a != '--json']

    try:
        if '--all' in args:
            msgs = get_all_messages()
            for m in msgs:
                ts = m.get('created_at', '')[:19]
                print(f"[{ts}] [{m.get('content_type','text')}] {m.get('content','')}")
        elif len(args) >= 2:
            msgs, user_a, user_b = get_messages(args[0], args[1])
            if not msgs:
                print('(无消息)')
            else:
                # 解密模式
                if key_path:
                    with open(key_path, 'r') as f:
                        my_key_b64 = f.read().strip()
                    their_key_b64 = get_user_key(user_b['id'])
                    if not their_key_b64:
                        print('⚠️  对方未注册公钥，无法解密')
                    else:
                        msgs = decrypt_messages(msgs, my_key_b64, their_key_b64)

                if use_json:
                    print(json_module.dumps(msgs, indent=2, ensure_ascii=False))
                else:
                    for m in msgs:
                        ts = m.get('created_at', '')[:19].replace('T', ' ')
                        ct = m.get('content', '')
                        print(f"[{ts}] {ct}")
        else:
            print('用户列表:')
            for u in get_users():
                print(f"  {u['username']} ({u['id']})")
            print('\n用法: python get_messages.py <用户A> <用户B> [--key 密钥.txt]')
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)
