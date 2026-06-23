/**
 * 从 Supabase 获取聊天记录 —— 供外部脚本调用
 *
 * 用法:
 *   node get-messages.js                          # 列出所有用户
 *   node get-messages.js alice bob                # 获取 alice 和 bob 的对话
 *   node get-messages.js --all                    # 获取所有消息
 *
 * 需设置环境变量或直接修改下方的 SUPABASE_URL 和 SUPABASE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_SERVICE_ROLE_KEY';

const https = require('https');

function api(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'ldglgjcpcohflmcmgobo.supabase.co',
      path,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY
      }
    };
    https.get(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Parse error: ' + d.substring(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function getUsers() {
  return api('/rest/v1/profiles?select=id,username');
}

async function getUserByName(username) {
  const users = await api('/rest/v1/profiles?select=id,username&username=eq.' + encodeURIComponent(username));
  return users[0];
}

async function getMessages(userA, userB) {
  let a = userA, b = userB;
  if (typeof a === 'string') a = (await getUserByName(a))?.id;
  if (typeof b === 'string') b = (await getUserByName(b))?.id;
  if (!a || !b) throw new Error('用户不存在');
  const inner = `and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`;
  return api('/rest/v1/messages?select=content,content_type,sender_id,created_at&or=(' + encodeURIComponent(inner) + ')&order=created_at.asc');
}

async function getAllMessages() {
  return api('/rest/v1/messages?select=content,content_type,sender_id,created_at&order=created_at.asc');
}

// ============ 主逻辑 ============
(async () => {
  const args = process.argv.slice(2);

  if (args.includes('--all')) {
    const msgs = await getAllMessages();
    msgs.forEach(m => console.log(`[${m.created_at}] ${m.content_type}: ${m.content}`));
    return;
  }

  if (args.length >= 2) {
    const msgs = await getMessages(args[0], args[1]);
    if (msgs.length === 0) {
      console.log('(无消息)');
    } else {
      msgs.forEach(m => {
        const time = new Date(m.created_at).toLocaleTimeString();
        console.log(`[${time}] ${m.content}`);
      });
    }
    return;
  }

  // 默认: 列出用户
  console.log('用户列表:');
  const users = await getUsers();
  users.forEach(u => console.log('  ' + u.username + ' (' + u.id + ')'));
  console.log('\n用法: node get-messages.js <用户A> <用户B>');
})().catch(e => console.error('Error:', e.message));
