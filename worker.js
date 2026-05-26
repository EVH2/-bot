// ==== 完整版 worker.js (第 1 部分 / 共 5 部分) ====
/**
 * ClawBot AI 角色扮演平台 - Cloudflare Worker
 * 完整版：含人设定时消息（早安/午安/晚安/两小时无聊天随机）
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

// ==================== 辅助函数 ====================
function randomString(length = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}
function generateInviteCode() { return randomString(6).toUpperCase(); }
function generateApiKey() { return 'sk-' + randomString(48); }
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
class JWT {
  static async sign(payload, secret) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = btoa(JSON.stringify(header));
    const encodedPayload = btoa(JSON.stringify({ ...payload, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
    const signature = await sha256(`${encodedHeader}.${encodedPayload}.${secret}`);
    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }
  static async verify(token, secret) {
    try {
      const [encodedHeader, encodedPayload, signature] = token.split('.');
      const expectedSignature = await sha256(`${encodedHeader}.${encodedPayload}.${secret}`);
      if (signature !== expectedSignature) return null;
      const payload = JSON.parse(atob(encodedPayload));
      if (payload.exp < Date.now()) return null;
      return payload;
    } catch { return null; }
  }
}
async function getJsonBody(c) { try { return await c.req.json(); } catch { return {}; } }
function json(c, data, message = 'success', code = 0) { return c.json({ code, message, data }); }
function errorJson(c, message = '操作失败', code = -1, status = 400) { return c.json({ code, message, data: null }, status); }
async function getAuthUser(c) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  return await JWT.verify(token, c.env.JWT_SECRET || 'default-secret');
}
async function getAuthAdmin(c) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  return await JWT.verify(token, (c.env.JWT_SECRET || 'default-secret') + '-admin');
}
const rateLimitMap = new Map();
async function checkRateLimit(userId, maxRequests = 15, windowMs = 60000) {
  const key = `rate_${userId}`;
  const now = Date.now();
  const record = rateLimitMap.get(key);
  if (!record || now - record.start > windowMs) { rateLimitMap.set(key, { count: 1, start: now }); return true; }
  if (record.count >= maxRequests) return false;
  record.count++;
  return true;
}
const sensitiveWords = ['政治', '色情', '暴力', '赌博', '毒品', '诈骗'];
function filterSensitiveContent(text) {
  let filtered = text;
  for (const word of sensitiveWords) filtered = filtered.replace(new RegExp(word, 'gi'), '***');
  return filtered;
}
function splitIntoSentences(text) {
  const sentences = text.replace(/([。！？.?!])/g, '$1|').split('|').map(s => s.trim()).filter(s => s.length > 0);
  return sentences.slice(0, 5);
}
async function sendWechatMessages(toUser, messages, c) {
  if (!toUser || messages.length === 0) return;
  const botUrl = await c.env.DB.prepare('SELECT value FROM config WHERE key = ?').bind('wechat_bot_url').first();
  const botKey = await c.env.DB.prepare('SELECT value FROM config WHERE key = ?').bind('wechat_bot_key').first();
  if (!botUrl?.value) return;
  for (const msg of messages) {
    await fetch(botUrl.value, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${botKey?.value || ''}` },
      body: JSON.stringify({ to_user: toUser, message: msg })
    });
    await new Promise(r => setTimeout(r, 500 + Math.random() * 2500));
  }
}
async function extractAndStoreMemory(userId, agentId, agentName, userMessage, aiResponse, c) {
  try {
    const apiKeyRecord = await c.env.DB.prepare('SELECT api_key, api_url FROM api_keys WHERE status = ? LIMIT 1').bind('active').first();
    if (!apiKeyRecord) return;
    const memoryPrompt = `你是一个记忆分析专家。分析以下对话，提取重要信息并以JSON数组格式返回：[{type:"preference"|"fact"|"habit", content:"内容", confidence:0-1}]。只返回数组。\n用户：${userMessage}\n${agentName}：${aiResponse}`;
    const memRes = await fetch(apiKeyRecord.api_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKeyRecord.api_key}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: memoryPrompt }] })
    });
    if (!memRes.ok) return;
    const memData = await memRes.json();
    let memoryJson = memData.response || memData.result || memData.content || '[]';
    if (typeof memoryJson === 'string') {
      memoryJson = memoryJson.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      const memories = JSON.parse(memoryJson);
      if (Array.isArray(memories)) {
        const config = await c.env.DB.prepare('SELECT value FROM config WHERE key = ?').bind('memory_max_count').first();
        const maxMemories = parseInt(config?.value || '500');
        const currentCount = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM long_term_memories WHERE user_id = ? AND agent_id = ?').bind(userId, agentId).first();
        if (currentCount?.cnt >= maxMemories) {
          const toDelete = currentCount.cnt - maxMemories + 1;
          await c.env.DB.prepare(`DELETE FROM long_term_memories WHERE id IN (SELECT id FROM long_term_memories WHERE user_id = ? AND agent_id = ? ORDER BY confidence ASC LIMIT ?)`).bind(userId, agentId, toDelete).run();
        }
        for (const mem of memories) {
          if (!mem.content || !mem.type) continue;
          const existing = await c.env.DB.prepare(`SELECT id, confidence FROM long_term_memories WHERE user_id = ? AND agent_id = ? AND memory_type = ? AND content = ?`).bind(userId, agentId, mem.type, mem.content).first();
          if (existing) {
            const newConfidence = Math.min(1, existing.confidence + 0.1);
            await c.env.DB.prepare('UPDATE long_term_memories SET confidence = ?, updated_at = ? WHERE id = ?').bind(newConfidence, Math.floor(Date.now() / 1000), existing.id).run();
          } else {
            const conflicting = await c.env.DB.prepare(`SELECT id, confidence FROM long_term_memories WHERE user_id = ? AND agent_id = ? AND memory_type = ? AND content != ? ORDER BY confidence DESC LIMIT 5`).bind(userId, agentId, mem.type, mem.content).first();
            if (conflicting && mem.confidence > conflicting.confidence + 0.2) {
              await c.env.DB.prepare('UPDATE long_term_memories SET memory_type = ?, updated_at = ? WHERE id = ?').bind('conflict', Math.floor(Date.now() / 1000), conflicting.id).run();
            }
            await c.env.DB.prepare('INSERT INTO long_term_memories (user_id, agent_id, memory_type, content, confidence) VALUES (?, ?, ?, ?, ?)').bind(userId, agentId, mem.type, filterSensitiveContent(mem.content), mem.confidence || 0.5).run();
          }
        }
      }
    }
  } catch (err) { console.error('Memory error:', err); }
}
// ==================== 中间件 ====================
app.use('/*', cors({ origin: '*', allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'], allowHeaders: ['Content-Type','Authorization'] }));
app.use('/*', async (c, next) => { const start = Date.now(); await next(); console.log(`${c.req.method} ${c.req.url} - ${Date.now()-start}ms`); });
// ==== 继续下一部分 ====
// ==== 完整版 worker.js (第 2 部分 / 共 5 部分) ====
// ==================== 健康检查 ====================
app.get('/', (c) => c.json({ name: 'ClawBot AI', version: '1.0.0', status: 'running' }));
app.get('/health', (c) => c.json({ status: 'ok' }));

// ==================== 认证 API ====================
app.post('/api/auth/register', async (c) => {
  try {
    const body = await getJsonBody(c);
    const { username, password, invite_link } = body;
    if (!username || username.length < 2 || username.length > 20) return errorJson(c, '用户名2-20字符');
    if (!password || password.length < 6) return errorJson(c, '密码至少6位');
    const passwordHash = await sha256(password + 'clawbot_salt');
    const inviteCode = generateInviteCode();
    let invitedBy = null;
    if (invite_link) {
      const inviteRecord = await c.env.DB.prepare('SELECT id FROM invite_links WHERE code = ? AND status = ?').bind(invite_link, 'active').first();
      if (inviteRecord) invitedBy = inviteRecord.id;
    }
    const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (existingUser) return errorJson(c, '用户名已存在');
    const result = await c.env.DB.prepare(`INSERT INTO users (username, password_hash, status, message_count, invite_code, invited_by) VALUES (?, ?, 'pending', 0, ?, ?)`).bind(username, passwordHash, inviteCode, invitedBy).run();
    if (invitedBy && body._invite_link_creator) {
      const reward = parseInt(c.env.DEFAULT_REWARD_MESSAGES || '50');
      await c.env.DB.prepare('UPDATE users SET message_count = message_count + ? WHERE id = ?').bind(reward, body._invite_link_creator).run();
      await c.env.DB.prepare('UPDATE invite_links SET used_count = used_count + 1 WHERE id = ?').bind(inviteRecord.id).run();
    }
    return json(c, { user_id: result.meta.last_row_id, invite_code: inviteCode }, '注册成功，请等待审核');
  } catch (err) { return errorJson(c, '注册失败：' + err.message); }
});
app.post('/api/auth/login', async (c) => {
  try {
    const body = await getJsonBody(c);
    const { username, password } = body;
    const passwordHash = await sha256(password + 'clawbot_salt');
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ? AND password_hash = ?').bind(username, passwordHash).first();
    if (!user) return errorJson(c, '用户名或密码错误');
    if (user.status === 'pending') return errorJson(c, '账号审核中');
    if (user.status === 'rejected') return errorJson(c, '账号审核未通过');
    if (user.status === 'disabled') return errorJson(c, '账号已停用');
    await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000), user.id).run();
    const token = await JWT.sign({ user_id: user.id, username: user.username, type: 'user' }, c.env.JWT_SECRET || 'default-secret');
    return json(c, { token, user: { id: user.id, username: user.username, email: user.email, message_count: user.message_count, invite_code: user.invite_code, status: user.status } }, '登录成功');
  } catch (err) { return errorJson(c, '登录失败'); }
});
app.get('/api/auth/me', async (c) => {
  const authUser = await getAuthUser(c);
  if (!authUser) return errorJson(c, '请先登录', 401);
  const user = await c.env.DB.prepare('SELECT id, username, email, status, message_count, invite_code, created_at FROM users WHERE id = ?').bind(authUser.user_id).first();
  return user ? json(c, user) : errorJson(c, '用户不存在', 404);
});

// ==================== 用户 API ====================
app.get('/api/user/profile', async (c) => {
  const authUser = await getAuthUser(c);
  if (!authUser) return errorJson(c, '请先登录', 401);
  const user = await c.env.DB.prepare('SELECT id, username, email, status, message_count, invite_code, created_at FROM users WHERE id = ?').bind(authUser.user_id).first();
  const stats = await c.env.DB.prepare(`SELECT COUNT(*) as total_agents, COALESCE(SUM(message_count),0) as total_messages FROM agents WHERE user_id = ?`).bind(authUser.user_id).first();
  const inviteStats = await c.env.DB.prepare('SELECT COUNT(*) as invited_count FROM users WHERE invited_by = ?').bind(authUser.user_id).first();
  return json(c, { ...user, stats: { total_agents: stats?.total_agents || 0, total_messages: stats?.total_messages || 0, invited_count: inviteStats?.invited_count || 0 } });
});
app.put('/api/user/profile', async (c) => {
  const authUser = await getAuthUser(c);
  if (!authUser) return errorJson(c, '请先登录', 401);
  const { email } = await getJsonBody(c);
  await c.env.DB.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').bind(email || '', Math.floor(Date.now() / 1000), authUser.user_id).run();
  return json(c, null, '资料更新成功');
});

// ==================== 智能体 API ====================
app.get('/api/agents', async (c) => {
  const authUser = await getAuthUser(c);
  if (!authUser) return errorJson(c, '请先登录', 401);
  const agents = await c.env.DB.prepare(`SELECT id, name, gender, persona, custom_prompt, prefer_short, continuous_send, message_count, status, created_at FROM agents WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC`).bind(authUser.user_id).all();
  return json(c, agents.results || []);
});
app.post('/api/agents', async (c) => {
  const authUser = await getAuthUser(c);
  if (!authUser) return errorJson(c, '请先登录', 401);
  const body = await getJsonBody(c);
  const { name, gender, persona, background, inner_thought, actions, speaking_style, rules, custom_prompt, prefer_short, continuous_send } = body;
  if (!name) return errorJson(c, '请输入智能体名称');
  const apiKey = generateApiKey();
  const result = await c.env.DB.prepare(`INSERT INTO agents (user_id, name, gender, persona, background, inner_thought, actions, speaking_style, rules, custom_prompt, prefer_short, continuous_send, api_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(authUser.user_id, name, gender || '女', persona || '', background || '', inner_thought || '', actions || '', speaking_style || '', rules || '', custom_prompt || '', prefer_short ? 1 : 0, continuous_send ? 1 : 0, apiKey).run();
  return json(c, { id: result.meta.last_row_id, api_key: apiKey }, '智能体创建成功');
});
app.put('/api/agents/:id', async (c) => {
  const authUser = await getAuthUser(c);
  if (!authUser) return errorJson(c, '请先登录', 401);
  const agentId = parseInt(c.req.param('id'));
  const body = await getJsonBody(c);
  const agent = await c.env.DB.prepare('SELECT id FROM agents WHERE id = ? AND user_id = ?').bind(agentId, authUser.user_id).first();
  if (!agent) return errorJson(c, '智能体不存在', 404);
  const { name, gender, persona, background, inner_thought, actions, speaking_style, rules, custom_prompt, prefer_short, continuous_send } = body;
  await c.env.DB.prepare(`UPDATE agents SET name = COALESCE(?, name), gender = COALESCE(?, gender), persona = COALESCE(?, persona), background = COALESCE(?, background), inner_thought = COALESCE(?, inner_thought), actions = COALESCE(?, actions), speaking_style = COALESCE(?, speaking_style), rules = COALESCE(?, rules), custom_prompt = COALESCE(?, custom_prompt), prefer_short = COALESCE(?, prefer_short), continuous_send = COALESCE(?, continuous_send), updated_at = ? WHERE id = ?`).bind(name, gender, persona, background, inner_thought, actions, speaking_style, rules, custom_prompt, prefer_short !== undefined ? (prefer_short ? 1 : 0) : null, continuous_send !== undefined ? (continuous_send ? 1 : 0) : null, Math.floor(Date.now() / 1000), agentId).run();
  return json(c, null, '更新成功');
});
app.delete('/api/agents/:id', async (c) => {
  const authUser = await getAuthUser(c);
  if (!authUser) return errorJson(c, '请先登录', 401);
  const agentId = parseInt(c.req.param('id'));
  const result = await c.env.DB.prepare('DELETE FROM agents WHERE id = ? AND user_id = ?').bind(agentId, authUser.user_id).run();
  if (result.meta.changes === 0) return errorJson(c, '智能体不存在', 404);
  return json(c, null, '删除成功');
});

// ==== 继续下一部分 ====
// ==== 完整版 worker.js (第 3 部分 / 共 5 部分) ====
// ==================== 聊天 API ====================
app.post('/api/agents/:id/chat', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) return errorJson(c, '请先登录', 401);
    const agentId = parseInt(c.req.param('id'));
    const body = await getJsonBody(c);
    const { message, wechat_send } = body;
    if (!message) return errorJson(c, '请输入消息');
    if (!await checkRateLimit(authUser.user_id)) return errorJson(c, '请求太频繁', 429);

    const user = await c.env.DB.prepare('SELECT id, status, message_count FROM users WHERE id = ?').bind(authUser.user_id).first();
    if (!user || user.status !== 'active') return errorJson(c, '账号状态异常');
    if (user.message_count <= 0) return json(c, { type: 'error', message: '消息余额不足' }, '余额不足');

    const agent = await c.env.DB.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ? AND status = ?').bind(agentId, authUser.user_id, 'active').first();
    if (!agent) return errorJson(c, '智能体不存在', 404);

    // 更新最后聊天时间
    await c.env.DB.prepare('UPDATE users SET last_chat_at = ? WHERE id = ?').bind(Date.now(), authUser.user_id).run();

    const apiKeyRecord = await c.env.DB.prepare('SELECT * FROM api_keys WHERE status = ? ORDER BY use_count ASC LIMIT 1').bind('active').first();
    const apiUrl = apiKeyRecord?.api_url || 'https://api.oiapi.net/aiRuntime';
    const apiKey = apiKeyRecord?.api_key || '';
    if (apiKeyRecord) await c.env.DB.prepare('UPDATE api_keys SET use_count = use_count + 1, last_used_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000), apiKeyRecord.id).run();

    const memories = await c.env.DB.prepare(`SELECT content, memory_type FROM long_term_memories WHERE user_id = ? AND agent_id = ? ORDER BY updated_at DESC LIMIT 20`).bind(authUser.user_id, agentId).all();
    const recentChats = await c.env.DB.prepare(`SELECT role, content FROM conversations WHERE user_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 5`).bind(authUser.user_id, agentId).all();

    let systemPrompt = `【角色设定】\n你叫"${agent.name}"，${agent.gender || '女孩'}。\n\n`;
    if (agent.persona) systemPrompt += `【性格】\n${agent.persona}\n\n`;
    if (agent.background) systemPrompt += `【背景】\n${agent.background}\n\n`;
    if (agent.inner_thought) systemPrompt += `【内心独白】\n${agent.inner_thought}\n\n`;
    if (agent.actions) systemPrompt += `【动作】\n${agent.actions}\n\n`;
    if (agent.speaking_style) systemPrompt += `【说话风格】\n${agent.speaking_style}\n\n`;
    if (agent.rules) systemPrompt += `【规则】\n${agent.rules}\n\n`;
    if (memories.results?.length) {
      systemPrompt += `【已知信息】\n`;
      for (const mem of memories.results) systemPrompt += `- ${mem.content}\n`;
      systemPrompt += `\n`;
    }
    if (agent.custom_prompt) systemPrompt += `【自定义】\n${agent.custom_prompt}\n\n`;
    if (agent.prefer_short == 1) systemPrompt += `【回复要求】短句，每句≤20字，口语化。\n`;
    else systemPrompt += `【回复要求】长句，逻辑连贯。\n`;
    if (recentChats.results?.length) {
      systemPrompt += `\n【最近对话】\n`;
      for (const chat of recentChats.results.reverse()) systemPrompt += `${chat.role === 'user' ? '用户' : agent.name}：${chat.content}\n`;
    }
    systemPrompt += `\n现在以${agent.name}的身份回复用户。`;

    let aiResponse = '';
    try {
      const aiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }] })
      });
      if (aiRes.ok) {
        const aiData = await aiRes.json();
        aiResponse = aiData.response || aiData.result || aiData.content || aiData.text || '';
        if (typeof aiResponse === 'object') aiResponse = aiResponse.text || aiResponse.content || '';
      } else aiResponse = '抱歉，我现在有点累~';
    } catch { aiResponse = '抱歉，出了点小问题~'; }
    aiResponse = filterSensitiveContent(aiResponse);

    await c.env.DB.prepare('INSERT INTO conversations (agent_id, user_id, role, content) VALUES (?, ?, ?, ?)').bind(agentId, authUser.user_id, 'user', filterSensitiveContent(message)).run();
    await c.env.DB.prepare('INSERT INTO conversations (agent_id, user_id, role, content) VALUES (?, ?, ?, ?)').bind(agentId, authUser.user_id, 'assistant', aiResponse).run();
    await c.env.DB.prepare('UPDATE users SET message_count = message_count - 1 WHERE id = ?').bind(authUser.user_id).run();
    await c.env.DB.prepare('UPDATE agents SET message_count = message_count + 1 WHERE id = ?').bind(agentId).run();

    await extractAndStoreMemory(authUser.user_id, agentId, agent.name, message, aiResponse, c);

    if (agent.continuous_send == 1) {
      const sentences = splitIntoSentences(aiResponse);
      if (wechat_send) await sendWechatMessages(body.wechat_target || '', sentences, c);
      return json(c, { type: 'continuous', sentences, total: sentences.length });
    }
    if (wechat_send) await sendWechatMessages(body.wechat_target || '', [aiResponse], c);
    return json(c, { type: 'normal', response: aiResponse });
  } catch (err) { return errorJson(c, '发送失败：' + err.message); }
});

// ==================== 充值 API ====================
app.post('/api/recharge/apply', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) return errorJson(c, '请先登录', 401);
    const body = await getJsonBody(c);
    const { amount, note } = body;
    if (!amount || amount < 1) return errorJson(c, '请输入正确的充值数量');
    await c.env.DB.prepare('INSERT INTO recharge_records (user_id, amount, note) VALUES (?, ?, ?)').bind(authUser.user_id, amount, note || '').run();
    return json(c, null, '充值申请已提交，请等待管理员处理');
  } catch (err) { return errorJson(c, '提交充值申请失败'); }
});
app.get('/api/recharge/records', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) return errorJson(c, '请先登录', 401);
    const records = await c.env.DB.prepare(`SELECT id, amount, status, note, created_at, processed_at FROM recharge_records WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).bind(authUser.user_id).all();
    return json(c, records.results || []);
  } catch (err) { return errorJson(c, '获取充值记录失败'); }
});

// ==================== 邀请 API ====================
app.get('/api/invite/info', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) return errorJson(c, '请先登录', 401);
    const user = await c.env.DB.prepare('SELECT invite_code FROM users WHERE id = ?').bind(authUser.user_id).first();
    const invitedCount = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM users WHERE invited_by = ?').bind(authUser.user_id).first();
    const myInviteLinks = await c.env.DB.prepare(`SELECT id, code, reward_messages, used_count, status, created_at FROM invite_links WHERE creator_id = ?`).bind(authUser.user_id).all();
    return json(c, { invite_code: user?.invite_code, invited_count: invitedCount?.cnt || 0, invite_links: myInviteLinks.results || [] });
  } catch (err) { return errorJson(c, '获取邀请信息失败'); }
});
app.post('/api/invite/apply', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) return errorJson(c, '请先登录', 401);
    const body = await getJsonBody(c);
    const { invite_code } = body;
    if (!invite_code) return errorJson(c, '请输入邀请码');
    const user = await c.env.DB.prepare('SELECT invited_by FROM users WHERE id = ?').bind(authUser.user_id).first();
    if (user?.invited_by) return errorJson(c, '您已经使用过邀请码了');
    const inviteLink = await c.env.DB.prepare('SELECT * FROM invite_links WHERE code = ? AND status = ?').bind(invite_code, 'active').first();
    if (!inviteLink) return errorJson(c, '邀请码无效或已过期');
    await c.env.DB.prepare('UPDATE users SET invited_by = ? WHERE id = ?').bind(inviteLink.creator_id, authUser.user_id).run();
    await c.env.DB.prepare('UPDATE users SET message_count = message_count + ? WHERE id = ?').bind(inviteLink.reward_messages, inviteLink.creator_id).run();
    await c.env.DB.prepare('UPDATE invite_links SET used_count = used_count + 1 WHERE id = ?').bind(inviteLink.id).run();
    await c.env.DB.prepare('UPDATE users SET message_count = message_count + ? WHERE id = ?').bind(inviteLink.reward_messages, authUser.user_id).run();
    return json(c, { reward: inviteLink.reward_messages }, '邀请码使用成功');
  } catch (err) { return errorJson(c, '使用邀请码失败'); }
});

// ==================== 公告 API ====================
app.get('/api/announcements', async (c) => {
  try {
    const announcements = await c.env.DB.prepare(`SELECT id, title, content, priority, created_at FROM announcements WHERE status = 'active' ORDER BY priority DESC, created_at DESC LIMIT 20`).all();
    return json(c, announcements.results || []);
  } catch (err) { return errorJson(c, '获取公告失败'); }
});

// ==================== 微信发送 API ====================
app.post('/api/wechat/send', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) return errorJson(c, '请先登录', 401);
    const body = await getJsonBody(c);
    const { to_user, messages, delay_between } = body;
    if (!to_user || !messages || !Array.isArray(messages)) return errorJson(c, '参数错误');
    await sendWechatMessages(to_user, messages, c);
    return json(c, null, '发送成功');
  } catch (err) { return errorJson(c, '发送失败'); }
});

// ==== 继续下一部分 ====
// ==== 完整版 worker.js (第 4 部分 / 共 5 部分) ====
// ==================== 管理后台 API ====================
app.post('/api/admin/login', async (c) => {
  try {
    const body = await getJsonBody(c);
    const { username, password } = body;
    if (!username || !password) return errorJson(c, '请输入用户名和密码');
    const passwordHash = await sha256(password + 'clawbot_salt');
    const admin = await c.env.DB.prepare('SELECT * FROM admins WHERE username = ? AND password_hash = ?').bind(username, passwordHash).first();
    if (!admin) return errorJson(c, '用户名或密码错误');
    const token = await JWT.sign({ admin_id: admin.id, username: admin.username, role: admin.role, type: 'admin' }, (c.env.JWT_SECRET || 'default-secret') + '-admin');
    return json(c, { token, admin: { id: admin.id, username: admin.username, role: admin.role } });
  } catch (err) { return errorJson(c, '登录失败'); }
});
const adminAuth = async (c, next) => {
  const admin = await getAuthAdmin(c);
  if (!admin) return errorJson(c, '请先登录管理员账号', 401);
  c.set('admin', admin);
  await next();
};
app.get('/api/admin/stats', adminAuth, async (c) => {
  try {
    const totalUsers = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM users').first();
    const activeUsers = await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM users WHERE status = 'active'").first();
    const pendingUsers = await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM users WHERE status = 'pending'").first();
    const totalAgents = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM agents').first();
    const totalMessages = await c.env.DB.prepare('SELECT COALESCE(SUM(message_count), 0) as total FROM agents').first();
    const pendingRecharges = await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM recharge_records WHERE status = 'pending'").first();
    const todayUsers = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM users WHERE created_at > ?`).bind(Math.floor(Date.now() / 1000) - 86400).first();
    return json(c, {
      total_users: totalUsers?.cnt || 0,
      active_users: activeUsers?.cnt || 0,
      pending_users: pendingUsers?.cnt || 0,
      total_agents: totalAgents?.cnt || 0,
      total_messages: totalMessages?.total || 0,
      pending_recharges: pendingRecharges?.cnt || 0,
      today_users: todayUsers?.cnt || 0
    });
  } catch (err) { return errorJson(c, '获取统计数据失败'); }
});
app.get('/api/admin/users', adminAuth, async (c) => {
  try {
    const status = c.req.query('status');
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = (page - 1) * limit;
    let sql = 'SELECT id, username, email, status, message_count, invite_code, created_at, last_login_at FROM users';
    let countSql = 'SELECT COUNT(*) as cnt FROM users';
    if (status) { sql += ' WHERE status = ?'; countSql += ' WHERE status = ?'; }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    const users = status ? await c.env.DB.prepare(sql).bind(status, limit, offset).all() : await c.env.DB.prepare(sql).bind(limit, offset).all();
    const count = status ? await c.env.DB.prepare(countSql).bind(status).first() : await c.env.DB.prepare(countSql).first();
    return json(c, { list: users.results || [], total: count?.cnt || 0, page, limit });
  } catch (err) { return errorJson(c, '获取用户列表失败'); }
});
app.put('/api/admin/users/:id', adminAuth, async (c) => {
  try {
    const userId = parseInt(c.req.param('id'));
    const body = await getJsonBody(c);
    const { status, message_count, action } = body;
    const admin = c.get('admin');
    if (action) {
      if (action === 'approve') await c.env.DB.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000), userId).run();
      else if (action === 'reject') await c.env.DB.prepare("UPDATE users SET status = 'rejected', updated_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000), userId).run();
      else if (action === 'disable') await c.env.DB.prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000), userId).run();
      else if (action === 'enable') await c.env.DB.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000), userId).run();
    }
    if (status) await c.env.DB.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').bind(status, Math.floor(Date.now() / 1000), userId).run();
    if (message_count !== undefined) await c.env.DB.prepare('UPDATE users SET message_count = ?, updated_at = ? WHERE id = ?').bind(message_count, Math.floor(Date.now() / 1000), userId).run();
    await c.env.DB.prepare('INSERT INTO admin_logs (admin_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)').bind(admin.admin_id, JSON.stringify(body), 'users', userId, JSON.stringify(body)).run();
    return json(c, null, '操作成功');
  } catch (err) { return errorJson(c, '操作失败'); }
});
app.delete('/api/admin/users/:id', adminAuth, async (c) => {
  try {
    const userId = parseInt(c.req.param('id'));
    const admin = c.get('admin');
    await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
    await c.env.DB.prepare('INSERT INTO admin_logs (admin_id, action, target_type, target_id) VALUES (?, ?, ?, ?)').bind(admin.admin_id, 'delete', 'users', userId).run();
    return json(c, null, '删除成功');
  } catch (err) { return errorJson(c, '删除失败'); }
});
app.get('/api/admin/recharges', adminAuth, async (c) => {
  try {
    const status = c.req.query('status');
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = (page - 1) * limit;
    let sql = `SELECT r.id, r.user_id, r.amount, r.status, r.note, r.created_at, r.processed_at, u.username FROM recharge_records r LEFT JOIN users u ON r.user_id = u.id`;
    let countSql = 'SELECT COUNT(*) as cnt FROM recharge_records';
    if (status) { sql += ' WHERE r.status = ?'; countSql += ' WHERE status = ?'; }
    sql += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
    const records = status ? await c.env.DB.prepare(sql).bind(status, limit, offset).all() : await c.env.DB.prepare(sql).bind(limit, offset).all();
    const count = status ? await c.env.DB.prepare(countSql).bind(status).first() : await c.env.DB.prepare(countSql).first();
    return json(c, { list: records.results || [], total: count?.cnt || 0, page, limit });
  } catch (err) { return errorJson(c, '获取充值列表失败'); }
});
app.put('/api/admin/recharges/:id', adminAuth, async (c) => {
  try {
    const rechargeId = parseInt(c.req.param('id'));
    const body = await getJsonBody(c);
    const { action, amount } = body;
    const admin = c.get('admin');
    const record = await c.env.DB.prepare('SELECT * FROM recharge_records WHERE id = ?').bind(rechargeId).first();
    if (!record) return errorJson(c, '充值记录不存在', 404);
    if (action === 'approve') {
      await c.env.DB.prepare(`UPDATE recharge_records SET status = 'approved', admin_id = ?, processed_at = ? WHERE id = ?`).bind(admin.admin_id, Math.floor(Date.now() / 1000), rechargeId).run();
      const addAmount = amount || record.amount;
      await c.env.DB.prepare('UPDATE users SET message_count = message_count + ? WHERE id = ?').bind(addAmount, record.user_id).run();
    } else if (action === 'reject') {
      await c.env.DB.prepare(`UPDATE recharge_records SET status = 'rejected', admin_id = ?, processed_at = ? WHERE id = ?`).bind(admin.admin_id, Math.floor(Date.now() / 1000), rechargeId).run();
    }
    return json(c, null, '处理成功');
  } catch (err) { return errorJson(c, '处理失败'); }
});
app.get('/api/admin/api-keys', adminAuth, async (c) => {
  try {
    const keys = await c.env.DB.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all();
    return json(c, keys.results || []);
  } catch (err) { return errorJson(c, '获取API Key列表失败'); }
});
app.post('/api/admin/api-keys', adminAuth, async (c) => {
  try {
    const body = await getJsonBody(c);
    const { api_key, api_url, name } = body;
    if (!api_key) return errorJson(c, '请输入 API Key');
    await c.env.DB.prepare('INSERT INTO api_keys (api_key, api_url, name) VALUES (?, ?, ?)').bind(api_key, api_url || 'https://api.oiapi.net/aiRuntime', name || '').run();
    return json(c, null, '添加成功');
  } catch (err) { if (err.message.includes('UNIQUE')) return errorJson(c, '该 API Key 已存在'); return errorJson(c, '添加失败'); }
});
app.post('/api/admin/api-keys/import', adminAuth, async (c) => {
  try {
    const body = await getJsonBody(c);
    const { keys } = body;
    if (!keys || !Array.isArray(keys)) return errorJson(c, '请提供有效的 Keys 数组');
    let imported = 0, skipped = 0;
    for (const item of keys) {
      try {
        await c.env.DB.prepare('INSERT INTO api_keys (api_key, api_url, name) VALUES (?, ?, ?)').bind(item.key || item.api_key, item.url || item.api_url || 'https://api.oiapi.net/aiRuntime', item.name || '').run();
        imported++;
      } catch { skipped++; }
    }
    return json(c, { imported, skipped }, `导入完成：成功 ${imported} 个，跳过 ${skipped} 个`);
  } catch (err) { return errorJson(c, '导入失败'); }
});
app.put('/api/admin/api-keys/:id', adminAuth, async (c) => {
  try {
    const keyId = parseInt(c.req.param('id'));
    const body = await getJsonBody(c);
    const { status, api_url, name } = body;
    await c.env.DB.prepare(`UPDATE api_keys SET status = COALESCE(?, status), api_url = COALESCE(?, api_url), name = COALESCE(?, name) WHERE id = ?`).bind(status, api_url, name, keyId).run();
    return json(c, null, '更新成功');
  } catch (err) { return errorJson(c, '更新失败'); }
});
app.delete('/api/admin/api-keys/:id', adminAuth, async (c) => {
  try {
    const keyId = parseInt(c.req.param('id'));
    await c.env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(keyId).run();
    return json(c, null, '删除成功');
  } catch (err) { return errorJson(c, '删除失败'); }
});
app.get('/api/admin/invite-links', adminAuth, async (c) => {
  try {
    const links = await c.env.DB.prepare(`SELECT il.*, u.username as creator_name FROM invite_links il LEFT JOIN users u ON il.creator_id = u.id ORDER BY il.created_at DESC`).all();
    return json(c, links.results || []);
  } catch (err) { return errorJson(c, '获取邀请链接失败'); }
});
app.post('/api/admin/invite-links', adminAuth, async (c) => {
  try {
    const body = await getJsonBody(c);
    const { creator_id, reward_messages } = body;
    if (!creator_id) return errorJson(c, '请选择创建者');
    const code = generateInviteCode();
    const reward = reward_messages || parseInt(c.env.DEFAULT_REWARD_MESSAGES || '50');
    await c.env.DB.prepare('INSERT INTO invite_links (code, creator_id, reward_messages) VALUES (?, ?, ?)').bind(code, creator_id, reward).run();
    return json(c, { code, reward }, '生成成功');
  } catch (err) { return errorJson(c, '生成失败'); }
});
app.delete('/api/admin/invite-links/:id', adminAuth, async (c) => {
  try {
    const linkId = parseInt(c.req.param('id'));
    await c.env.DB.prepare('DELETE FROM invite_links WHERE id = ?').bind(linkId).run();
    return json(c, null, '删除成功');
  } catch (err) { return errorJson(c, '删除失败'); }
});
app.get('/api/admin/announcements', adminAuth, async (c) => {
  try {
    const announcements = await c.env.DB.prepare('SELECT * FROM announcements ORDER BY priority DESC, created_at DESC').all();
    return json(c, announcements.results || []);
  } catch (err) { return errorJson(c, '获取公告列表失败'); }
});
app.post('/api/admin/announcements', adminAuth, async (c) => {
  try {
    const body = await getJsonBody(c);
    const { title, content, priority } = body;
    if (!title || !content) return errorJson(c, '标题和内容不能为空');
    await c.env.DB.prepare('INSERT INTO announcements (title, content, priority) VALUES (?, ?, ?)').bind(title, content, priority || 0).run();
    return json(c, null, '创建成功');
  } catch (err) { return errorJson(c, '创建失败'); }
});
app.put('/api/admin/announcements/:id', adminAuth, async (c) => {
  try {
    const announcementId = parseInt(c.req.param('id'));
    const body = await getJsonBody(c);
    const { title, content, priority, status } = body;
    await c.env.DB.prepare(`UPDATE announcements SET title = COALESCE(?, title), content = COALESCE(?, content), priority = COALESCE(?, priority), status = COALESCE(?, status), updated_at = ? WHERE id = ?`).bind(title, content, priority, status, Math.floor(Date.now() / 1000), announcementId).run();
    return json(c, null, '更新成功');
  } catch (err) { return errorJson(c, '更新失败'); }
});
app.delete('/api/admin/announcements/:id', adminAuth, async (c) => {
  try {
    const announcementId = parseInt(c.req.param('id'));
    await c.env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(announcementId).run();
    return json(c, null, '删除成功');
  } catch (err) { return errorJson(c, '删除失败'); }
});
app.get('/api/admin/config', adminAuth, async (c) => {
  try {
    const configs = await c.env.DB.prepare('SELECT * FROM config ORDER BY key').all();
    return json(c, configs.results || []);
  } catch (err) { return errorJson(c, '获取配置失败'); }
});
app.put('/api/admin/config', adminAuth, async (c) => {
  try {
    const body = await getJsonBody(c);
    const { key, value } = body;
    if (!key) return errorJson(c, '配置键不能为空');
    await c.env.DB.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`).bind(key, value, Math.floor(Date.now() / 1000), value, Math.floor(Date.now() / 1000)).run();
    return json(c, null, '设置成功');
  } catch (err) { return errorJson(c, '设置失败'); }
});
app.get('/api/admin/all-users', adminAuth, async (c) => {
  try {
    const users = await c.env.DB.prepare("SELECT id, username FROM users WHERE status = ? ORDER BY username").bind('active').all();
    return json(c, users.results || []);
  } catch (err) { return errorJson(c, '获取用户列表失败'); }
});

// ==== 继续下一部分 ====
// ==== 完整版 worker.js (第 5 部分 / 共 5 部分) ====
// ==================== 定时任务（按人设生成消息）====================
async function generateGreetingByAgent(agent, env, type) {
  const apiKeyRecord = await env.DB.prepare('SELECT api_key, api_url FROM api_keys WHERE status = ? LIMIT 1').bind('active').first();
  if (!apiKeyRecord) return null;
  const promptMap = {
    morning: `你现在是【${agent.name}】，性格：${agent.persona || '温柔'}。背景：${agent.background || ''}。说话风格：${agent.speaking_style || '自然'}。\n现在是早上，请用你的风格给用户发一条早安消息，长度不超过50字，要符合你的人设。只输出消息内容，不要加任何解释。`,
    noon: `你现在是【${agent.name}】，性格：${agent.persona || '温柔'}。现在是中午，请用你的风格给用户发一条中午问候，提醒对方注意休息，长度不超过50字。只输出消息。`,
    night: `你现在是【${agent.name}】，性格：${agent.persona || '温柔'}。现在是晚上，请用你的风格给用户发一条晚安消息，温馨体贴，长度不超过50字。只输出消息。`,
    random: `你现在是【${agent.name}】，性格：${agent.persona || '温柔'}。用户已经两小时没和你聊天了，请用你的风格发一条想他的消息，自然不做作，长度不超过50字。只输出消息。`
  };
  const prompt = promptMap[type] || promptMap.morning;
  try {
    const resp = await fetch(apiKeyRecord.api_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKeyRecord.api_key}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] })
    });
    if (resp.ok) {
      const data = await resp.json();
      return data.response || data.result || data.content || data.text || null;
    }
  } catch (err) { console.error('生成问候失败:', err); }
  return null;
}

async function checkInactiveUsersAndSendRandom(env) {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const today = new Date().toISOString().slice(0,10);
  const inactiveUsers = await env.DB
    .prepare(`
      SELECT u.id, u.username, u.wechat_id, u.last_chat_at, u.last_random_msg_date,
             a.id as agent_id, a.name, a.persona, a.background, a.speaking_style
      FROM users u
      LEFT JOIN agents a ON a.user_id = u.id AND a.status = 'active'
      WHERE u.status = 'active'
        AND (u.last_chat_at < ? OR u.last_chat_at IS NULL)
        AND (u.last_random_msg_date IS NULL OR u.last_random_msg_date != ?)
    `)
    .bind(twoHoursAgo, today)
    .all();
  if (!inactiveUsers.results.length) return;
  const botUrl = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind('wechat_bot_url').first();
  const botKey = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind('wechat_bot_key').first();
  if (!botUrl?.value) return;
  for (const user of inactiveUsers.results) {
    if (!user.agent_id) continue;
    const agent = { name: user.name, persona: user.persona, background: user.background, speaking_style: user.speaking_style };
    const message = await generateGreetingByAgent(agent, env, 'random');
    if (!message) continue;
    if (user.wechat_id) {
      await fetch(botUrl.value, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${botKey?.value || ''}` },
        body: JSON.stringify({ to_user: user.wechat_id, message })
      });
    }
    await env.DB.prepare('UPDATE users SET last_random_msg_date = ? WHERE id = ?').bind(today, user.id).run();
    await new Promise(r => setTimeout(r, 500));
  }
}

async function scheduledTask(event, env, ctx) {
  try {
    const cron = event.cron;
    let type = null;
    if (cron === "0 8 * * *") type = 'morning';
    else if (cron === "0 12 * * *") type = 'noon';
    else if (cron === "0 22 * * *") type = 'night';
    else if (cron === "0 * * * *") {
      await checkInactiveUsersAndSendRandom(env);
      return;
    }
    if (!type) return;

    const enabled = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(`${type}_push_enabled`).first();
    if (enabled?.value !== 'true') return;

    const users = await env.DB
      .prepare(`
        SELECT u.id, u.username, u.wechat_id, 
               a.id as agent_id, a.name, a.persona, a.background, a.speaking_style
        FROM users u
        LEFT JOIN agents a ON a.user_id = u.id AND a.status = 'active'
        WHERE u.status = 'active'
        ORDER BY u.id
      `)
      .all();

    const botUrl = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind('wechat_bot_url').first();
    const botKey = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind('wechat_bot_key').first();
    if (!botUrl?.value) return;

    for (const user of users.results || []) {
      if (!user.agent_id) continue;
      const agent = { name: user.name, persona: user.persona, background: user.background, speaking_style: user.speaking_style };
      const message = await generateGreetingByAgent(agent, env, type);
      if (!message) continue;
      if (user.wechat_id) {
        await fetch(botUrl.value, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${botKey?.value || ''}` },
          body: JSON.stringify({ to_user: user.wechat_id, message })
        });
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) { console.error('定时任务错误:', err); }
}

// ==================== 错误处理 ====================
app.notFound((c) => c.json({ code: 404, message: 'Not Found' }, 404));
app.onError((c, err) => { console.error(err); return c.json({ code: 500, message: '服务器错误' }, 500); });

// ==================== 导出 ====================
export default {
  fetch: app.fetch,
  scheduled: scheduledTask
};
// ==== 完整版 worker.js (第 5 部分 / 共 5 部分) 结束 ====
