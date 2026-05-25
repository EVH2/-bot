/**
 * ClawBot AI 角色扮演平台 - Cloudflare Worker
 * 使用 Hono 框架，支持 D1 数据库
 * 
 * 功能模块：
 * - 认证模块（注册、登录、JWT）
 * - 用户模块（资料管理）
 * - 智能体模块（CRUD、聊天、记忆）
 * - 充值模块
 * - 邀请模块
 * - 公告模块
 * - 微信发送模块
 * - 管理后台模块
 * - 定时任务（早安推送）
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';

// 初始化 Hono 应用
const app = new Hono();

// ==================== 辅助函数 ====================

/**
 * 生成随机字符串
 */
function randomString(length = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * 生成邀请码（6位）
 */
function generateInviteCode() {
  return randomString(6).toUpperCase();
}

/**
 * 生成 API Key
 */
function generateApiKey() {
  return 'sk-' + randomString(48);
}

/**
 * SHA-256 哈希（使用 Web Crypto API）
 */
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 简单的 JWT 实现
 */
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
    } catch {
      return null;
    }
  }
}

/**
 * 获取请求体
 */
async function getJsonBody(c) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/**
 * 标准响应格式
 */
function json(c, data, message = 'success', code = 0) {
  return c.json({ code, message, data });
}

function errorJson(c, message = '操作失败', code = -1, status = 400) {
  return c.json({ code, message, data: null }, status);
}

/**
 * 获取用户信息（从 JWT）
 */
async function getAuthUser(c) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7);
  const payload = await JWT.verify(token, c.env.JWT_SECRET || 'default-secret');
  return payload;
}

/**
 * 验证管理员身份
 */
async function getAuthAdmin(c) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7);
  const payload = await JWT.verify(token, (c.env.JWT_SECRET || 'default-secret') + '-admin');
  return payload;
}

/**
 * 限流检查（简单实现）
 */
const rateLimitMap = new Map();
async function checkRateLimit(userId, maxRequests = 15, windowMs = 60000) {
  const key = `rate_${userId}`;
  const now = Date.now();
  const record = rateLimitMap.get(key);
  
  if (!record || now - record.start > windowMs) {
    rateLimitMap.set(key, { count: 1, start: now });
    return true;
  }
  
  if (record.count >= maxRequests) {
    return false;
  }
  
  record.count++;
  return true;
}

/**
 * 敏感词过滤
 */
const sensitiveWords = ['政治', '色情', '暴力', '赌博', '毒品', '诈骗'];
function filterSensitiveContent(text) {
  let filtered = text;
  for (const word of sensitiveWords) {
    filtered = filtered.replace(new RegExp(word, 'gi'), '***');
  }
  return filtered;
}

// ==================== 中间件 ====================

// CORS 配置
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// 请求日志
app.use('/*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`${c.req.method} ${c.req.url} - ${ms}ms`);
});

// ==================== 健康检查 ====================

app.get('/', (c) => c.json({ 
  name: 'ClawBot AI Platform', 
  version: '1.0.0',
  status: 'running'
}));

app.get('/health', (c) => c.json({ status: 'ok' }));

// ==================== 静态文件（前端）====================

// 前端页面路由
const staticRoutes = [
  { path: '/', file: 'index.html' },
  { path: '/register', file: 'register.html' },
  { path: '/login', file: 'login.html' },
  { path: '/dashboard', file: 'dashboard.html' },
  { path: '/create-agent', file: 'create_agent.html' },
  { path: '/invite', file: 'invite.html' },
  { path: '/recharge', file: 'recharge.html' },
  { path: '/admin/login', file: 'admin/login.html' },
  { path: '/admin', file: 'admin/dashboard.html' },
];

// ==================== 认证 API ====================

/**
 * 用户注册
 * POST /api/auth/register
 */
app.post('/api/auth/register', async (c) => {
  try {
    const body = await getJsonBody(c);
    const { username, password, invite_link } = body;

    // 参数验证
    if (!username || username.length < 2 || username.length > 20) {
      return errorJson(c, '用户名长度需在2-20个字符之间');
    }
    if (!password || password.length < 6) {
      return errorJson(c, '密码长度不能少于6位');
    }

    // 密码哈希
    const passwordHash = await sha256(password + 'clawbot_salt');
    const inviteCode = generateInviteCode();
    
    // 检查邀请链接
    let invitedBy = null;
    if (invite_link) {
      const inviteRecord = await c.env.DB
        .prepare('SELECT id, used_count FROM invite_links WHERE code = ? AND status = ?')
        .bind(invite_link, 'active')
        .first();
      if (inviteRecord) {
        invitedBy = inviteRecord.id;
      }
    }

    // 检查用户名是否存在
    const existingUser = await c.env.DB
      .prepare('SELECT id FROM users WHERE username = ?')
      .bind(username)
      .first();

    if (existingUser) {
      return errorJson(c, '用户名已被注册');
    }

    // 创建用户
    const result = await c.env.DB
      .prepare(`
        INSERT INTO users (username, password_hash, status, message_count, invite_code, invited_by)
        VALUES (?, ?, 'pending', 0, ?, ?)
      `)
      .bind(username, passwordHash, inviteCode, invitedBy)
      .run();

    // 如果有邀请人，增加奖励
    if (invitedBy && body._invite_link_creator) {
      const reward = parseInt(c.env.DEFAULT_REWARD_MESSAGES || '50');
      await c.env.DB
        .prepare('UPDATE users SET message_count = message_count + ? WHERE id = ?')
        .bind(reward, body._invite_link_creator)
        .run();
      await c.env.DB
        .prepare('UPDATE invite_links SET used_count = used_count + 1 WHERE id = ?')
        .bind(inviteRecord.id)
        .run();
    }

    return json(c, { user_id: result.meta.last_row_id, invite_code: inviteCode }, '注册成功，请等待审核');
  } catch (err) {
    console.error('Register error:', err);
    return errorJson(c, '注册失败：' + err.message);
  }
});

/**
 * 用户登录
 * POST /api/auth/login
 */
app.post('/api/auth/login', async (c) => {
  try {
    const body = await getJsonBody(c);
    const { username, password } = body;

    if (!username || !password) {
      return errorJson(c, '请输入用户名和密码');
    }

    const passwordHash = await sha256(password + 'clawbot_salt');
    
    const user = await c.env.DB
      .prepare('SELECT * FROM users WHERE username = ? AND password_hash = ?')
      .bind(username, passwordHash)
      .first();

    if (!user) {
      return errorJson(c, '用户名或密码错误');
    }

    // 检查账号状态
    if (user.status === 'pending') {
      return errorJson(c, '账号正在审核中，请耐心等待');
    }
    if (user.status === 'rejected') {
      return errorJson(c, '账号审核未通过，请联系管理员');
    }
    if (user.status === 'disabled') {
      return errorJson(c, '账号已被停用，请联系管理员');
    }

    // 更新最后登录时间
    await c.env.DB
      .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .bind(Math.floor(Date.now() / 1000), user.id)
      .run();

    // 生成 JWT
    const token = await JWT.sign({
      user_id: user.id,
      username: user.username,
      type: 'user'
    }, c.env.JWT_SECRET || 'default-secret');

    return json(c, {
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        message_count: user.message_count,
        invite_code: user.invite_code,
        status: user.status
      }
    }, '登录成功');
  } catch (err) {
    console.error('Login error:', err);
    return errorJson(c, '登录失败：' + err.message);
  }
});

/**
 * 获取当前用户信息
 * GET /api/auth/me
 */
app.get('/api/auth/me', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const user = await c.env.DB
      .prepare('SELECT id, username, email, status, message_count, invite_code, created_at FROM users WHERE id = ?')
      .bind(authUser.user_id)
      .first();

    if (!user) {
      return errorJson(c, '用户不存在', 404);
    }

    return json(c, user);
  } catch (err) {
    console.error('Get user error:', err);
    return errorJson(c, '获取用户信息失败');
  }
});

// ==================== 用户 API ====================

/**
 * 获取用户资料和统计
 * GET /api/user/profile
 */
app.get('/api/user/profile', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const user = await c.env.DB
      .prepare('SELECT id, username, email, status, message_count, invite_code, created_at FROM users WHERE id = ?')
      .bind(authUser.user_id)
      .first();

    if (!user) {
      return errorJson(c, '用户不存在', 404);
    }

    // 获取统计信息
    const stats = await c.env.DB
      .prepare(`
        SELECT 
          COUNT(DISTINCT id) as total_agents,
          COALESCE(SUM(message_count), 0) as total_messages
        FROM agents WHERE user_id = ?
      `)
      .bind(authUser.user_id)
      .first();

    // 获取邀请统计
    const inviteStats = await c.env.DB
      .prepare('SELECT COUNT(*) as invited_count FROM users WHERE invited_by = ?')
      .bind(authUser.user_id)
      .first();

    return json(c, {
      ...user,
      stats: {
        total_agents: stats?.total_agents || 0,
        total_messages: stats?.total_messages || 0,
        invited_count: inviteStats?.invited_count || 0
      }
    });
  } catch (err) {
    console.error('Get profile error:', err);
    return errorJson(c, '获取资料失败');
  }
});

/**
 * 更新用户资料
 * PUT /api/user/profile
 */
app.put('/api/user/profile', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const body = await getJsonBody(c);
    const { email } = body;

    await c.env.DB
      .prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?')
      .bind(email || '', Math.floor(Date.now() / 1000), authUser.user_id)
      .run();

    return json(c, null, '资料更新成功');
  } catch (err) {
    console.error('Update profile error:', err);
    return errorJson(c, '更新资料失败');
  }
});

// ==================== 智能体 API ====================

/**
 * 获取智能体列表
 * GET /api/agents
 */
app.get('/api/agents', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const agents = await c.env.DB
      .prepare(`
        SELECT id, name, gender, persona, custom_prompt, prefer_short, continuous_send, 
               message_count, status, created_at
        FROM agents 
        WHERE user_id = ? AND status = 'active'
        ORDER BY created_at DESC
      `)
      .bind(authUser.user_id)
      .all();

    return json(c, agents.results || []);
  } catch (err) {
    console.error('Get agents error:', err);
    return errorJson(c, '获取智能体列表失败');
  }
});

/**
 * 创建智能体
 * POST /api/agents
 */
app.post('/api/agents', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const body = await getJsonBody(c);
    const {
      name, gender, persona, background, inner_thought, actions,
      speaking_style, rules, custom_prompt, prefer_short, continuous_send
    } = body;

    if (!name || name.length < 1) {
      return errorJson(c, '请输入智能体名称');
    }

    // 自动分配 API Key
    const apiKey = generateApiKey();

    const result = await c.env.DB
      .prepare(`
        INSERT INTO agents (
          user_id, name, gender, persona, background, inner_thought, actions,
          speaking_style, rules, custom_prompt, prefer_short, continuous_send, api_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        authUser.user_id, name, gender || '女', persona || '', background || '',
        inner_thought || '', actions || '', speaking_style || '', rules || '',
        custom_prompt || '', prefer_short ? 1 : 0, continuous_send ? 1 : 0, apiKey
      )
      .run();

    return json(c, {
      id: result.meta.last_row_id,
      api_key: apiKey
    }, '智能体创建成功');
  } catch (err) {
    console.error('Create agent error:', err);
    return errorJson(c, '创建智能体失败');
  }
});

/**
 * 更新智能体
 * PUT /api/agents/:id
 */
app.put('/api/agents/:id', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const agentId = parseInt(c.req.param('id'));
    const body = await getJsonBody(c);

    // 验证归属
    const agent = await c.env.DB
      .prepare('SELECT id FROM agents WHERE id = ? AND user_id = ?')
      .bind(agentId, authUser.user_id)
      .first();

    if (!agent) {
      return errorJson(c, '智能体不存在或无权操作', 404);
    }

    const {
      name, gender, persona, background, inner_thought, actions,
      speaking_style, rules, custom_prompt, prefer_short, continuous_send
    } = body;

    await c.env.DB
      .prepare(`
        UPDATE agents SET 
          name = COALESCE(?, name),
          gender = COALESCE(?, gender),
          persona = COALESCE(?, persona),
          background = COALESCE(?, background),
          inner_thought = COALESCE(?, inner_thought),
          actions = COALESCE(?, actions),
          speaking_style = COALESCE(?, speaking_style),
          rules = COALESCE(?, rules),
          custom_prompt = COALESCE(?, custom_prompt),
          prefer_short = COALESCE(?, prefer_short),
          continuous_send = COALESCE(?, continuous_send),
          updated_at = ?
        WHERE id = ?
      `)
      .bind(
        name, gender, persona, background, inner_thought, actions,
        speaking_style, rules, custom_prompt,
        prefer_short !== undefined ? (prefer_short ? 1 : 0) : null,
        continuous_send !== undefined ? (continuous_send ? 1 : 0) : null,
        Math.floor(Date.now() / 1000), agentId
      )
      .run();

    return json(c, null, '更新成功');
  } catch (err) {
    console.error('Update agent error:', err);
    return errorJson(c, '更新智能体失败');
  }
});

/**
 * 删除智能体
 * DELETE /api/agents/:id
 */
app.delete('/api/agents/:id', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const agentId = parseInt(c.req.param('id'));

    const result = await c.env.DB
      .prepare('DELETE FROM agents WHERE id = ? AND user_id = ?')
      .bind(agentId, authUser.user_id)
      .run();

    if (result.meta.changes === 0) {
      return errorJson(c, '智能体不存在或无权操作', 404);
    }

    return json(c, null, '删除成功');
  } catch (err) {
    console.error('Delete agent error:', err);
    return errorJson(c, '删除智能体失败');
  }
});

// ==================== 聊天 API（核心）====================

/**
 * 发送聊天消息
 * POST /api/agents/:id/chat
 */
app.post('/api/agents/:id/chat', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const agentId = parseInt(c.req.param('id'));
    const body = await getJsonBody(c);
    const { message, wechat_send } = body;

    if (!message || message.trim().length === 0) {
      return errorJson(c, '请输入消息内容');
    }

    // 限流检查
    if (!await checkRateLimit(authUser.user_id)) {
      return errorJson(c, '请求过于频繁，请稍后再试', 429);
    }

    // 获取用户信息，检查余额
    const user = await c.env.DB
      .prepare('SELECT id, status, message_count FROM users WHERE id = ?')
      .bind(authUser.user_id)
      .first();

    if (!user) {
      return errorJson(c, '用户不存在', 404);
    }

    if (user.status !== 'active') {
      return errorJson(c, '账号状态异常，请联系管理员');
    }

    if (user.message_count <= 0) {
      return json(c, {
        type: 'error',
        message: '您的可用时长已用完，请联系管理员充值继续使用哦~'
      }, '余额不足');
    }

    // 获取智能体信息
    const agent = await c.env.DB
      .prepare('SELECT * FROM agents WHERE id = ? AND user_id = ? AND status = ?')
      .bind(agentId, authUser.user_id, 'active')
      .first();

    if (!agent) {
      return errorJson(c, '智能体不存在', 404);
    }

    // 获取 AI API 配置
    const apiKeyRecord = await c.env.DB
      .prepare('SELECT * FROM api_keys WHERE status = ? ORDER BY use_count ASC LIMIT 1')
      .bind('active')
      .first();

    const apiUrl = apiKeyRecord?.api_url || 'https://api.oiapi.net/aiRuntime';
    const apiKey = apiKeyRecord?.api_key || '';

    // 更新 API Key 使用次数
    if (apiKeyRecord) {
      await c.env.DB
        .prepare('UPDATE api_keys SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
        .bind(Math.floor(Date.now() / 1000), apiKeyRecord.id)
        .run();
    }

    // 从长期记忆加载
    const memories = await c.env.DB
      .prepare(`
        SELECT content, memory_type FROM long_term_memories 
        WHERE user_id = ? AND agent_id = ?
        ORDER BY updated_at DESC LIMIT 20
      `)
      .bind(authUser.user_id, agentId)
      .all();

    // 从对话历史加载最近5条
    const recentChats = await c.env.DB
      .prepare(`
        SELECT role, content FROM conversations 
        WHERE user_id = ? AND agent_id = ?
        ORDER BY created_at DESC LIMIT 5
      `)
      .bind(authUser.user_id, agentId)
      .all();

    // 构建 system prompt
    let systemPrompt = `【角色设定】\n`;
    systemPrompt += `你是一个叫"${agent.name}"的${agent.gender || '女孩'}。\n\n`;
    
    if (agent.persona) systemPrompt += `【性格特点】\n${agent.persona}\n\n`;
    if (agent.background) systemPrompt += `【背景故事】\n${agent.background}\n\n`;
    if (agent.inner_thought) systemPrompt += `【内心独白】\n${agent.inner_thought}\n\n`;
    if (agent.actions) systemPrompt += `【动作习惯】\n${agent.actions}\n\n`;
    if (agent.speaking_style) systemPrompt += `【说话风格】\n${agent.speaking_style}\n\n`;
    if (agent.rules) systemPrompt += `【角色规则】\n${agent.rules}\n\n`;

    // 添加记忆
    if (memories.results && memories.results.length > 0) {
      systemPrompt += `【已知信息】\n`;
      for (const mem of memories.results) {
        systemPrompt += `- ${mem.content}\n`;
      }
      systemPrompt += `\n`;
    }

    // 添加自定义人设
    if (agent.custom_prompt) {
      systemPrompt += `【自定义设定】\n${agent.custom_prompt}\n\n`;
    }

    // 添加回复模式
    if (agent.prefer_short == 1) {
      systemPrompt += `【回复要求】使用短句，每句话不超过20字，口语化，活泼自然。\n`;
    } else {
      systemPrompt += `【回复要求】使用完整长句，逻辑连贯，表达丰富。\n`;
    }

    // 添加最近对话（用于上下文连贯性）
    if (recentChats.results && recentChats.results.length > 0) {
      systemPrompt += `\n【最近对话】\n`;
      for (const chat of recentChats.results.reverse()) {
        systemPrompt += `${chat.role === 'user' ? '用户' : agent.name}：${chat.content}\n`;
      }
    }

    systemPrompt += `\n现在请以${agent.name}的身份回复用户。`;

    // 调用 AI API
    let aiResponse = '';
    try {
      const aiRequestBody = {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ]
      };

      const aiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(aiRequestBody)
      });

      if (aiRes.ok) {
        const aiData = await aiRes.json();
        aiResponse = aiData.response || aiData.result || aiData.content || aiData.text || '';
        
        // 处理可能的多种返回格式
        if (typeof aiResponse === 'object') {
          aiResponse = aiResponse.text || aiResponse.content || JSON.stringify(aiResponse);
        }
      } else {
        aiResponse = '抱歉，我现在有点累了，让我休息一下~';
      }
    } catch (aiErr) {
      console.error('AI API error:', aiErr);
      aiResponse = '抱歉，出了点小问题，请稍后再试~';
    }

    // 过滤敏感内容
    aiResponse = filterSensitiveContent(aiResponse);

    // 保存用户消息
    await c.env.DB
      .prepare('INSERT INTO conversations (agent_id, user_id, role, content) VALUES (?, ?, ?, ?)')
      .bind(agentId, authUser.user_id, 'user', filterSensitiveContent(message))
      .run();

    // 保存 AI 回复
    await c.env.DB
      .prepare('INSERT INTO conversations (agent_id, user_id, role, content) VALUES (?, ?, ?, ?)')
      .bind(agentId, authUser.user_id, 'assistant', aiResponse)
      .run();

    // 更新消息计数
    await c.env.DB
      .prepare('UPDATE users SET message_count = message_count - 1 WHERE id = ?')
      .bind(authUser.user_id)
      .run();

    await c.env.DB
      .prepare('UPDATE agents SET message_count = message_count + 1 WHERE id = ?')
      .bind(agentId)
      .run();

    // 调用记忆提取
    await extractAndStoreMemory(authUser.user_id, agentId, agent.name, message, aiResponse, c);

    // 处理连续发送模式
    if (agent.continuous_send == 1) {
      const sentences = splitIntoSentences(aiResponse);
      const result = {
        type: 'continuous',
        sentences: sentences,
        total: sentences.length
      };

      // 如果需要发送微信
      if (wechat_send) {
        await sendWechatMessages(body.wechat_target || '', sentences, c);
      }

      return json(c, result);
    }

    // 如果需要发送微信
    if (wechat_send) {
      await sendWechatMessages(body.wechat_target || '', [aiResponse], c);
    }

    return json(c, {
      type: 'normal',
      response: aiResponse
    });
  } catch (err) {
    console.error('Chat error:', err);
    return errorJson(c, '发送消息失败：' + err.message);
  }
});

/**
 * 将文本拆分为句子数组
 */
function splitIntoSentences(text) {
  // 按句子分割
  const sentences = text
    .replace(/([。！？.?!])/g, '$1|')
    .split('|')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  // 最多返回5条
  return sentences.slice(0, 5);
}

/**
 * 提取并存储记忆
 */
async function extractAndStoreMemory(userId, agentId, agentName, userMessage, aiResponse, c) {
  try {
    // 提取记忆的 prompt
    const memoryPrompt = `你是一个记忆分析专家。请分析以下对话，提取重要的信息并以JSON数组格式返回。

要求：
1. 只提取有长期价值的信息（如用户偏好、事实、习惯等）
2. 忽略即时性对话内容
3. 返回格式：[{type: "preference"|"fact"|"habit", content: "具体内容", confidence: 0.0-1.0}]
4. confidence表示你对这个记忆的确信程度
5. 只返回JSON数组，不要其他内容

对话：
用户：${userMessage}
${agentName}：${aiResponse}

请分析：`;

    // 调用 AI 提取记忆（使用简单的内部调用，不走完整流程避免递归）
    const apiKeyRecord = await c.env.DB
      .prepare('SELECT api_key, api_url FROM api_keys WHERE status = ? LIMIT 1')
      .bind('active')
      .first();

    if (!apiKeyRecord) return;

    try {
      const memRes = await fetch(apiKeyRecord.api_url || 'https://api.oiapi.net/aiRuntime', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKeyRecord.api_key}`
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: memoryPrompt }]
        })
      });

      if (!memRes.ok) return;

      const memData = await memRes.json();
      let memoryJson = memData.response || memData.result || memData.content || '[]';

      // 解析 JSON
      if (typeof memoryJson === 'string') {
        memoryJson = memoryJson.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        const memories = JSON.parse(memoryJson);
        
        if (Array.isArray(memories)) {
          // 获取配置的最大记忆数
          const config = await c.env.DB
            .prepare('SELECT value FROM config WHERE key = ?')
            .bind('memory_max_count')
            .first();
          const maxMemories = parseInt(config?.value || '500');

          // 检查当前记忆数量
          const currentCount = await c.env.DB
            .prepare('SELECT COUNT(*) as cnt FROM long_term_memories WHERE user_id = ? AND agent_id = ?')
            .bind(userId, agentId)
            .first();

          // 如果超过限制，删除置信度最低的
          if (currentCount?.cnt >= maxMemories) {
            const toDelete = currentCount.cnt - maxMemories + 1;
            await c.env.DB
              .prepare(`
                DELETE FROM long_term_memories 
                WHERE id IN (
                  SELECT id FROM long_term_memories 
                  WHERE user_id = ? AND agent_id = ?
                  ORDER BY confidence ASC 
                  LIMIT ?
                )
              `)
              .bind(userId, agentId, toDelete)
              .run();
          }

          // 存储新记忆，处理冲突
          for (const mem of memories) {
            if (!mem.content || !mem.type) continue;

            // 检查是否已存在相似的记忆
            const existing = await c.env.DB
              .prepare(`
                SELECT id, confidence FROM long_term_memories 
                WHERE user_id = ? AND agent_id = ? AND memory_type = ? AND content = ?
              `)
              .bind(userId, agentId, mem.type, mem.content)
              .first();

            if (existing) {
              // 更新置信度
              const newConfidence = Math.min(1, existing.confidence + 0.1);
              await c.env.DB
                .prepare('UPDATE long_term_memories SET confidence = ?, updated_at = ? WHERE id = ?')
                .bind(newConfidence, Math.floor(Date.now() / 1000), existing.id)
                .run();
            } else {
              // 检查冲突记忆（新记忆置信度 > 旧记忆 + 0.2 则替换）
              const conflicting = await c.env.DB
              .prepare(`
                SELECT id, confidence FROM long_term_memories 
                WHERE user_id = ? AND agent_id = ? AND memory_type = ? AND content != ?
                ORDER BY confidence DESC LIMIT 5
              `)
              .bind(userId, agentId, mem.type, mem.content)
              .first();

              if (conflicting && mem.confidence > conflicting.confidence + 0.2) {
                // 标记为冲突
                await c.env.DB
                  .prepare(`
                    UPDATE long_term_memories 
                    SET memory_type = 'conflict', updated_at = ?
                    WHERE id = ?
                  `)
                  .bind(Math.floor(Date.now() / 1000), conflicting.id)
                  .run();
              }

              // 插入新记忆
              await c.env.DB
                .prepare(`
                  INSERT INTO long_term_memories (user_id, agent_id, memory_type, content, confidence)
                  VALUES (?, ?, ?, ?, ?)
                `)
                .bind(userId, agentId, mem.type, filterSensitiveContent(mem.content), mem.confidence || 0.5)
                .run();
            }
          }
        }
      }
    } catch (memErr) {
      console.error('Memory extraction error:', memErr);
    }
  } catch (err) {
    console.error('Store memory error:', err);
  }
}

/**
 * 发送微信消息（模拟微信机器人 API）
 */
async function sendWechatMessages(toUser, messages, c) {
  if (!toUser || messages.length === 0) return;

  // 获取微信机器人配置
  const botUrl = await c.env.DB
    .prepare('SELECT value FROM config WHERE key = ?')
    .bind('wechat_bot_url')
    .first();
  const botKey = await c.env.DB
    .prepare('SELECT value FROM config WHERE key = ?')
    .bind('wechat_bot_key')
    .first();

  if (!botUrl?.value) return;

  try {
    for (const msg of messages) {
      await fetch(botUrl.value, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${botKey?.value || ''}`
        },
        body: JSON.stringify({
          to_user: toUser,
          message: msg
        })
      });

      // 随机延迟 0.5-3 秒
      const delay = 500 + Math.random() * 2500;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  } catch (err) {
    console.error('Wechat send error:', err);
  }
}

// ==================== 充值 API ====================

/**
 * 申请充值
 * POST /api/recharge/apply
 */
app.post('/api/recharge/apply', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const body = await getJsonBody(c);
    const { amount, note } = body;

    if (!amount || amount < 1) {
      return errorJson(c, '请输入正确的充值数量');
    }

    await c.env.DB
      .prepare('INSERT INTO recharge_records (user_id, amount, note) VALUES (?, ?, ?)')
      .bind(authUser.user_id, amount, note || '')
      .run();

    return json(c, null, '充值申请已提交，请等待管理员处理');
  } catch (err) {
    console.error('Recharge apply error:', err);
    return errorJson(c, '提交充值申请失败');
  }
});

/**
 * 获取充值记录
 * GET /api/recharge/records
 */
app.get('/api/recharge/records', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const records = await c.env.DB
      .prepare(`
        SELECT id, amount, status, note, created_at, processed_at 
        FROM recharge_records 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT 50
      `)
      .bind(authUser.user_id)
      .all();

    return json(c, records.results || []);
  } catch (err) {
    console.error('Get recharge records error:', err);
    return errorJson(c, '获取充值记录失败');
  }
});

// ==================== 邀请 API ====================

/**
 * 获取邀请信息
 * GET /api/invite/info
 */
app.get('/api/invite/info', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const user = await c.env.DB
      .prepare('SELECT invite_code FROM users WHERE id = ?')
      .bind(authUser.user_id)
      .first();

    const invitedCount = await c.env.DB
      .prepare('SELECT COUNT(*) as cnt FROM users WHERE invited_by = ?')
      .bind(authUser.user_id)
      .first();

    const myInviteLinks = await c.env.DB
      .prepare(`
        SELECT id, code, reward_messages, used_count, status, created_at 
        FROM invite_links WHERE creator_id = ?
      `)
      .bind(authUser.user_id)
      .all();

    return json(c, {
      invite_code: user?.invite_code,
      invited_count: invitedCount?.cnt || 0,
      invite_links: myInviteLinks.results || []
    });
  } catch (err) {
    console.error('Get invite info error:', err);
    return errorJson(c, '获取邀请信息失败');
  }
});

/**
 * 使用邀请码
 * POST /api/invite/apply
 */
app.post('/api/invite/apply', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const body = await getJsonBody(c);
    const { invite_code } = body;

    if (!invite_code) {
      return errorJson(c, '请输入邀请码');
    }

    // 检查是否已使用过邀请码
    const user = await c.env.DB
      .prepare('SELECT invited_by FROM users WHERE id = ?')
      .bind(authUser.user_id)
      .first();

    if (user?.invited_by) {
      return errorJson(c, '您已经使用过邀请码了');
    }

    // 查找邀请链接
    const inviteLink = await c.env.DB
      .prepare('SELECT * FROM invite_links WHERE code = ? AND status = ?')
      .bind(invite_code, 'active')
      .first();

    if (!inviteLink) {
      return errorJson(c, '邀请码无效或已过期');
    }

    // 更新用户邀请关系
    await c.env.DB
      .prepare('UPDATE users SET invited_by = ? WHERE id = ?')
      .bind(inviteLink.creator_id, authUser.user_id)
      .run();

    // 给邀请人增加奖励
    await c.env.DB
      .prepare('UPDATE users SET message_count = message_count + ? WHERE id = ?')
      .bind(inviteLink.reward_messages, inviteLink.creator_id)
      .run();

    // 更新邀请链接使用次数
    await c.env.DB
      .prepare('UPDATE invite_links SET used_count = used_count + 1 WHERE id = ?')
      .bind(inviteLink.id)
      .run();

    // 给新用户奖励
    await c.env.DB
      .prepare('UPDATE users SET message_count = message_count + ? WHERE id = ?')
      .bind(inviteLink.reward_messages, authUser.user_id)
      .run();

    return json(c, { reward: inviteLink.reward_messages }, '邀请码使用成功');
  } catch (err) {
    console.error('Apply invite code error:', err);
    return errorJson(c, '使用邀请码失败');
  }
});

// ==================== 公告 API ====================

/**
 * 获取公告列表
 * GET /api/announcements
 */
app.get('/api/announcements', async (c) => {
  try {
    const announcements = await c.env.DB
      .prepare(`
        SELECT id, title, content, priority, created_at 
        FROM announcements 
        WHERE status = 'active'
        ORDER BY priority DESC, created_at DESC 
        LIMIT 20
      `)
      .all();

    return json(c, announcements.results || []);
  } catch (err) {
    console.error('Get announcements error:', err);
    return errorJson(c, '获取公告失败');
  }
});

// ==================== 微信发送 API ====================

/**
 * 发送微信消息
 * POST /api/wechat/send
 */
app.post('/api/wechat/send', async (c) => {
  try {
    const authUser = await getAuthUser(c);
    if (!authUser) {
      return errorJson(c, '请先登录', 401);
    }

    const body = await getJsonBody(c);
    const { to_user, messages, delay_between } = body;

    if (!to_user || !messages || !Array.isArray(messages)) {
      return errorJson(c, '参数错误');
    }

    await sendWechatMessages(to_user, messages, c);

    return json(c, null, '发送成功');
  } catch (err) {
    console.error('Wechat send error:', err);
    return errorJson(c, '发送失败');
  }
});

// ==================== 管理后台 API ====================

/**
 * 管理员登录
 * POST /api/admin/login
 */
app.post('/api/admin/login', async (c) => {
  try {
    const body = await getJsonBody(c);
    const { username, password } = body;

    if (!username || !password) {
      return errorJson(c, '请输入用户名和密码');
    }

    const passwordHash = await sha256(password + 'clawbot_salt');
    
    const admin = await c.env.DB
      .prepare('SELECT * FROM admins WHERE username = ? AND password_hash = ?')
      .bind(username, passwordHash)
      .first();

    if (!admin) {
      return errorJson(c, '用户名或密码错误');
    }

    const token = await JWT.sign({
      admin_id: admin.id,
      username: admin.username,
      role: admin.role,
      type: 'admin'
    }, (c.env.JWT_SECRET || 'default-secret') + '-admin');

    return json(c, {
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role
      }
    });
  } catch (err) {
    console.error('Admin login error:', err);
    return errorJson(c, '登录失败');
  }
});

/**
 * 验证管理员身份中间件
 */
const adminAuth = async (c, next) => {
  const admin = await getAuthAdmin(c);
  if (!admin) {
    return errorJson(c, '请先登录管理员账号', 401);
  }
  c.set('admin', admin);
  await next();
};

/**
 * 数据概览
 * GET /api/admin/stats
 */
app.get('/api/admin/stats', adminAuth, async (c) => {
  try {
    const totalUsers = await c.env.DB
      .prepare('SELECT COUNT(*) as cnt FROM users')
      .first();

    const activeUsers = await c.env.DB
      .prepare("SELECT COUNT(*) as cnt FROM users WHERE status = 'active'")
      .first();

    const pendingUsers = await c.env.DB
      .prepare("SELECT COUNT(*) as cnt FROM users WHERE status = 'pending'")
      .first();

    const totalAgents = await c.env.DB
      .prepare('SELECT COUNT(*) as cnt FROM agents')
      .first();

    const totalMessages = await c.env.DB
      .prepare('SELECT COALESCE(SUM(message_count), 0) as total FROM agents')
      .first();

    const pendingRecharges = await c.env.DB
      .prepare("SELECT COUNT(*) as cnt FROM recharge_records WHERE status = 'pending'")
      .first();

    const todayUsers = await c.env.DB
      .prepare(`
        SELECT COUNT(*) as cnt FROM users 
        WHERE created_at > ?
      `)
      .bind(Math.floor(Date.now() / 1000) - 86400)
      .first();

    return json(c, {
      total_users: totalUsers?.cnt || 0,
      active_users: activeUsers?.cnt || 0,
      pending_users: pendingUsers?.cnt || 0,
      total_agents: totalAgents?.cnt || 0,
      total_messages: totalMessages?.total || 0,
      pending_recharges: pendingRecharges?.cnt || 0,
      today_users: todayUsers?.cnt || 0
    });
  } catch (err) {
    console.error('Get stats error:', err);
    return errorJson(c, '获取统计数据失败');
  }
});

/**
 * 用户列表
 * GET /api/admin/users
 */
app.get('/api/admin/users', adminAuth, async (c) => {
  try {
    const status = c.req.query('status');
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = (page - 1) * limit;

    let sql = 'SELECT id, username, email, status, message_count, invite_code, created_at, last_login_at FROM users';
    let countSql = 'SELECT COUNT(*) as cnt FROM users';
    
    if (status) {
      sql += ' WHERE status = ?';
      countSql += ' WHERE status = ?';
    }
    
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

    const users = status 
      ? await c.env.DB.prepare(sql).bind(status, limit, offset).all()
      : await c.env.DB.prepare(sql).bind(limit, offset).all();

    const count = status
      ? await c.env.DB.prepare(countSql).bind(status).first()
      : await c.env.DB.prepare(countSql).first();

    return json(c, {
      list: users.results || [],
      total: count?.cnt || 0,
      page,
      limit
    });
  } catch (err) {
    console.error('Get users error:', err);
    return errorJson(c, '获取用户列表失败');
  }
});

/**
 * 操作用户
 * PUT /api/admin/users/:id
 */
app.put('/api/admin/users/:id', adminAuth, async (c) => {
  try {
    const userId = parseInt(c.req.param('id'));
    const body = await getJsonBody(c);
    const { status, message_count, action } = body;
    const admin = c.get('admin');

    // 处理预设操作
    if (action) {
      switch (action) {
        case 'approve':
          await c.env.DB
            .prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?")
            .bind(Math.floor(Date.now() / 1000), userId)
            .run();
          break;
        case 'reject':
          await c.env.DB
            .prepare("UPDATE users SET status = 'rejected', updated_at = ? WHERE id = ?")
            .bind(Math.floor(Date.now() / 1000), userId)
            .run();
          break;
        case 'disable':
          await c.env.DB
            .prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?")
            .bind(Math.floor(Date.now() / 1000), userId)
            .run();
          break;
        case 'enable':
          await c.env.DB
            .prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?")
            .bind(Math.floor(Date.now() / 1000), userId)
            .run();
          break;
      }
    }

    // 直接设置状态
    if (status) {
      await c.env.DB
        .prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
        .bind(status, Math.floor(Date.now() / 1000), userId)
        .run();
    }

    // 设置消息额度
    if (message_count !== undefined) {
      await c.env.DB
        .prepare('UPDATE users SET message_count = ?, updated_at = ? WHERE id = ?')
        .bind(message_count, Math.floor(Date.now() / 1000), userId)
        .run();
    }

    // 记录操作日志
    await c.env.DB
      .prepare('INSERT INTO admin_logs (admin_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)')
      .bind(admin.admin_id, JSON.stringify(body), 'users', userId, JSON.stringify(body))
      .run();

    return json(c, null, '操作成功');
  } catch (err) {
    console.error('Update user error:', err);
    return errorJson(c, '操作失败');
  }
});

/**
 * 删除用户
 * DELETE /api/admin/users/:id
 */
app.delete('/api/admin/users/:id', adminAuth, async (c) => {
  try {
    const userId = parseInt(c.req.param('id'));
    const admin = c.get('admin');

    await c.env.DB
      .prepare('DELETE FROM users WHERE id = ?')
      .bind(userId)
      .run();

    await c.env.DB
      .prepare('INSERT INTO admin_logs (admin_id, action, target_type, target_id) VALUES (?, ?, ?, ?)')
      .bind(admin.admin_id, 'delete', 'users', userId)
      .run();

    return json(c, null, '删除成功');
  } catch (err) {
    console.error('Delete user error:', err);
    return errorJson(c, '删除失败');
  }
});

/**
 * 充值列表
 * GET /api/admin/recharges
 */
app.get('/api/admin/recharges', adminAuth, async (c) => {
  try {
    const status = c.req.query('status');
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = (page - 1) * limit;

    let sql = `
      SELECT r.id, r.user_id, r.amount, r.status, r.note, r.created_at, r.processed_at,
             u.username 
      FROM recharge_records r
      LEFT JOIN users u ON r.user_id = u.id
    `;
    let countSql = 'SELECT COUNT(*) as cnt FROM recharge_records';
    
    if (status) {
      sql += ' WHERE r.status = ?';
      countSql += ' WHERE status = ?';
    }
    
    sql += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';

    const records = status 
      ? await c.env.DB.prepare(sql).bind(status, limit, offset).all()
      : await c.env.DB.prepare(sql).bind(limit, offset).all();

    const count = status
      ? await c.env.DB.prepare(countSql).bind(status).first()
      : await c.env.DB.prepare(countSql).first();

    return json(c, {
      list: records.results || [],
      total: count?.cnt || 0,
      page,
      limit
    });
  } catch (err) {
    console.error('Get recharges error:', err);
    return errorJson(c, '获取充值列表失败');
  }
});

/**
 * 处理充值
 * PUT /api/admin/recharges/:id
 */
app.put('/api/admin/recharges/:id', adminAuth, async (c) => {
  try {
    const rechargeId = parseInt(c.req.param('id'));
    const body = await getJsonBody(c);
    const { action, amount } = body;
    const admin = c.get('admin');

    const record = await c.env.DB
      .prepare('SELECT * FROM recharge_records WHERE id = ?')
      .bind(rechargeId)
      .first();

    if (!record) {
      return errorJson(c, '充值记录不存在', 404);
    }

    if (action === 'approve') {
      // 通过充值
      await c.env.DB
        .prepare(`
          UPDATE recharge_records 
          SET status = 'approved', admin_id = ?, processed_at = ?
          WHERE id = ?
        `)
        .bind(admin.admin_id, Math.floor(Date.now() / 1000), rechargeId)
        .run();

      // 增加用户余额
      const addAmount = amount || record.amount;
      await c.env.DB
        .prepare('UPDATE users SET message_count = message_count + ? WHERE id = ?')
        .bind(addAmount, record.user_id)
        .run();
    } else if (action === 'reject') {
      await c.env.DB
        .prepare(`
          UPDATE recharge_records 
          SET status = 'rejected', admin_id = ?, processed_at = ?
          WHERE id = ?
        `)
        .bind(admin.admin_id, Math.floor(Date.now() / 1000), rechargeId)
        .run();
    }

    return json(c, null, '处理成功');
  } catch (err) {
    console.error('Process recharge error:', err);
    return errorJson(c, '处理失败');
  }
});

/**
 * API Key 列表
 * GET /api/admin/api-keys
 */
app.get('/api/admin/api-keys', adminAuth, async (c) => {
  try {
    const keys = await c.env.DB
      .prepare('SELECT * FROM api_keys ORDER BY created_at DESC')
      .all();

    return json(c, keys.results || []);
  } catch (err) {
    console.error('Get api keys error:', err);
    return errorJson(c, '获取API Key列表失败');
  }
});

/**
 * 添加 API Key
 * POST /api/admin/api-keys
 */
app.post('/api/admin/api-keys', adminAuth, async (c) => {
  try {
    const body = await getJsonBody(c);
    const { api_key, api_url, name } = body;

    if (!api_key) {
      return errorJson(c, '请输入 API Key');
    }

    await c.env.DB
      .prepare('INSERT INTO api_keys (api_key, api_url, name) VALUES (?, ?, ?)')
      .bind(api_key, api_url || 'https://api.oiapi.net/aiRuntime', name || '')
      .run();

    return json(c, null, '添加成功');
  } catch (err) {
    console.error('Add api key error:', err);
    if (err.message.includes('UNIQUE')) {
      return errorJson(c, '该 API Key 已存在');
    }
    return errorJson(c, '添加失败');
  }
});

/**
 * 批量导入 API Keys
 * POST /api/admin/api-keys/import
 */
app.post('/api/admin/api-keys/import', adminAuth, async (c) => {
  try {
    const body = await getJsonBody(c);
    const { keys } = body;

    if (!keys || !Array.isArray(keys)) {
      return errorJson(c, '请提供有效的 Keys 数组');
    }

    let imported = 0;
    let skipped = 0;

    for (const item of keys) {
      try {
        await c.env.DB
          .prepare('INSERT INTO api_keys (api_key, api_url, name) VALUES (?, ?, ?)')
          .bind(item.key || item.api_key, item.url || item.api_url || 'https://api.oiapi.net/aiRuntime', item.name || '')
          .run();
        imported++;
      } catch {
        skipped++;
      }
    }

    return json(c, { imported, skipped }, `导入完成：成功 ${imported} 个，跳过 ${skipped} 个`);
  } catch (err) {
    console.error('Import api keys error:', err);
    return errorJson(c, '导入失败');
  }
});

/**
 * 更新 API Key 状态
 * PUT /api/admin/api-keys/:id
 */
app.put('/api/admin/api-keys/:id', adminAuth, async (c) => {
  try {
    const keyId = parseInt(c.req.param('id'));
    const body = await getJsonBody(c);
    const { status, api_url, name } = body;

    await c.env.DB
      .prepare(`
        UPDATE api_keys 
        SET status = COALESCE(?, status),
            api_url = COALESCE(?, api_url),
            name = COALESCE(?, name)
        WHERE id = ?
      `)
      .bind(status, api_url, name, keyId)
      .run();

    return json(c, null, '更新成功');
  } catch (err) {
    console.error('Update api key error:', err);
    return errorJson(c, '更新失败');
  }
});

/**
 * 删除 API Key
 * DELETE /api/admin/api-keys/:id
 */
app.delete('/api/admin/api-keys/:id', adminAuth, async (c) => {
  try {
    const keyId = parseInt(c.req.param('id'));

    await c.env.DB
      .prepare('DELETE FROM api_keys WHERE id = ?')
      .bind(keyId)
      .run();

    return json(c, null, '删除成功');
  } catch (err) {
    console.error('Delete api key error:', err);
    return errorJson(c, '删除失败');
  }
});

/**
 * 邀请链接列表
 * GET /api/admin/invite-links
 */
app.get('/api/admin/invite-links', adminAuth, async (c) => {
  try {
    const links = await c.env.DB
      .prepare(`
        SELECT il.*, u.username as creator_name
        FROM invite_links il
        LEFT JOIN users u ON il.creator_id = u.id
        ORDER BY il.created_at DESC
      `)
      .all();

    return json(c, links.results || []);
  } catch (err) {
    console.error('Get invite links error:', err);
    return errorJson(c, '获取邀请链接失败');
  }
});

/**
 * 生成邀请链接
 * POST /api/admin/invite-links
 */
app.post('/api/admin/invite-links', adminAuth, async (c) => {
  try {
    const body = await getJsonBody(c);
    const { creator_id, reward_messages } = body;

    if (!creator_id) {
      return errorJson(c, '请选择创建者');
    }

    const code = generateInviteCode();
    const reward = reward_messages || parseInt(c.env.DEFAULT_REWARD_MESSAGES || '50');

    await c.env.DB
      .prepare('INSERT INTO invite_links (code, creator_id, reward_messages) VALUES (?, ?, ?)')
      .bind(code, creator_id, reward)
      .run();

    return json(c, { code, reward }, '生成成功');
  } catch (err) {
    console.error('Create invite link error:', err);
    return errorJson(c, '生成失败');
  }
});

/**
 * 删除邀请链接
 * DELETE /api/admin/invite-links/:id
 */
app.delete('/api/admin/invite-links/:id', adminAuth, async (c) => {
  try {
    const linkId = parseInt(c.req.param('id'));

    await c.env.DB
      .prepare('DELETE FROM invite_links WHERE id = ?')
      .bind(linkId)
      .run();

    return json(c, null, '删除成功');
  } catch (err) {
    console.error('Delete invite link error:', err);
    return errorJson(c, '删除失败');
  }
});

/**
 * 公告列表
 * GET /api/admin/announcements
 */
app.get('/api/admin/announcements', adminAuth, async (c) => {
  try {
    const announcements = await c.env.DB
      .prepare('SELECT * FROM announcements ORDER BY priority DESC, created_at DESC')
      .all();

    return json(c, announcements.results || []);
  } catch (err) {
    console.error('Get announcements error:', err);
    return errorJson(c, '获取公告列表失败');
  }
});

/**
 * 创建公告
 * POST /api/admin/announcements
 */
app.post('/api/admin/announcements', adminAuth, async (c) => {
  try {
    const body = await getJsonBody(c);
    const { title, content, priority } = body;

    if (!title || !content) {
      return errorJson(c, '标题和内容不能为空');
    }

    await c.env.DB
      .prepare('INSERT INTO announcements (title, content, priority) VALUES (?, ?, ?)')
      .bind(title, content, priority || 0)
      .run();

    return json(c, null, '创建成功');
  } catch (err) {
    console.error('Create announcement error:', err);
    return errorJson(c, '创建失败');
  }
});

/**
 * 更新公告
 * PUT /api/admin/announcements/:id
 */
app.put('/api/admin/announcements/:id', adminAuth, async (c) => {
  try {
    const announcementId = parseInt(c.req.param('id'));
    const body = await getJsonBody(c);
    const { title, content, priority, status } = body;

    await c.env.DB
      .prepare(`
        UPDATE announcements 
        SET title = COALESCE(?, title),
            content = COALESCE(?, content),
            priority = COALESCE(?, priority),
            status = COALESCE(?, status),
            updated_at = ?
        WHERE id = ?
      `)
      .bind(title, content, priority, status, Math.floor(Date.now() / 1000), announcementId)
      .run();

    return json(c, null, '更新成功');
  } catch (err) {
    console.error('Update announcement error:', err);
    return errorJson(c, '更新失败');
  }
});

/**
 * 删除公告
 * DELETE /api/admin/announcements/:id
 */
app.delete('/api/admin/announcements/:id', adminAuth, async (c) => {
  try {
    const announcementId = parseInt(c.req.param('id'));

    await c.env.DB
      .prepare('DELETE FROM announcements WHERE id = ?')
      .bind(announcementId)
      .run();

    return json(c, null, '删除成功');
  } catch (err) {
    console.error('Delete announcement error:', err);
    return errorJson(c, '删除失败');
  }
});

/**
 * 获取/设置全局配置
 * GET/PUT /api/admin/config
 */
app.get('/api/admin/config', adminAuth, async (c) => {
  try {
    const configs = await c.env.DB
      .prepare('SELECT * FROM config ORDER BY key')
      .all();

    return json(c, configs.results || []);
  } catch (err) {
    console.error('Get config error:', err);
    return errorJson(c, '获取配置失败');
  }
});

app.put('/api/admin/config', adminAuth, async (c) => {
  try {
    const body = await getJsonBody(c);
    const { key, value } = body;

    if (!key) {
      return errorJson(c, '配置键不能为空');
    }

    await c.env.DB
      .prepare(`
        INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
      `)
      .bind(key, value, Math.floor(Date.now() / 1000), value, Math.floor(Date.now() / 1000))
      .run();

    return json(c, null, '设置成功');
  } catch (err) {
    console.error('Set config error:', err);
    return errorJson(c, '设置失败');
  }
});

/**
 * 获取所有用户（用于管理员选择）
 * GET /api/admin/all-users
 */
app.get('/api/admin/all-users', adminAuth, async (c) => {
  try {
    const users = await c.env.DB
      .prepare('SELECT id, username FROM users WHERE status = ? ORDER BY username')
      .bind('active')
      .all();

    return json(c, users.results || []);
  } catch (err) {
    console.error('Get all users error:', err);
    return errorJson(c, '获取用户列表失败');
  }
});

// ==================== 定时任务 ====================

/**
 * 早安推送（Cron Trigger）
 * 每天 8:00 UTC 执行
 */
app.scheduled(async (c, env) => {
  try {
    // 检查是否启用早安推送
    const enabled = await c.env.DB
      .prepare('SELECT value FROM config WHERE key = ?')
      .bind('morning_push_enabled')
      .first();

    if (enabled?.value !== 'true') {
      console.log('Morning push is disabled');
      return;
    }

    // 获取有早安推送偏好的用户（通过记忆判断）
    // 这里简化处理，向所有活跃用户推送
    const users = await c.env.DB
      .prepare("SELECT u.id, u.username FROM users u WHERE u.status = 'active' LIMIT 100")
      .all();

    // 获取默认 AI API
    const apiKeyRecord = await c.env.DB
      .prepare('SELECT api_key, api_url FROM api_keys WHERE status = ? LIMIT 1')
      .bind('active')
      .first();

    if (!apiKeyRecord) {
      console.log('No active API key found');
      return;
    }

    // 获取微信机器人配置
    const botUrl = await c.env.DB
      .prepare('SELECT value FROM config WHERE key = ?')
      .bind('wechat_bot_url')
      .first();

    const botKey = await c.env.DB
      .prepare('SELECT value FROM config WHERE key = ?')
      .bind('wechat_bot_key')
      .first();

    if (!botUrl?.value) {
      console.log('Wechat bot not configured');
      return;
    }

    // 早安消息模板
    const morningMessages = [
      '早安呀~今天也要开心哦！☀️',
      '早上好~新的一天开始了呢~',
      '早安~记得吃早餐哦~',
      '早呀~今天天气怎么样呀？',
      '早安~有什么想聊的吗？'
    ];

    for (const user of users.results || []) {
      // 获取用户最近对话的智能体
      const recentAgent = await c.env.DB
        .prepare(`
          SELECT a.id, a.name, a.api_key, a.prefer_short 
          FROM agents a
          INNER JOIN conversations c ON a.id = c.agent_id
          WHERE c.user_id = ? AND a.status = 'active'
          ORDER BY c.created_at DESC
          LIMIT 1
        `)
        .bind(user.id)
        .first();

      if (!recentAgent) continue;

      // 生成个性化早安消息
      const greeting = morningMessages[Math.floor(Math.random() * morningMessages.length)];
      const personalizedMessage = `早安~${greeting}`;

      // 调用微信发送
      try {
        await fetch(botUrl.value, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${botKey?.value || ''}`
          },
          body: JSON.stringify({
            to_user: user.username,
            message: personalizedMessage
          })
        });
      } catch (e) {
        console.error('Failed to send morning message to', user.username, e);
      }

      // 避免请求过快
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('Morning push completed');
  } catch (err) {
    console.error('Morning push error:', err);
  }
});

// ==================== 错误处理 ====================

app.notFound((c) => {
  return c.json({ code: 404, message: '页面不存在', data: null }, 404);
});

app.onError((c, err) => {
  console.error('Server error:', err);
  return c.json({ code: 500, message: '服务器错误', data: null }, 500);
});

// ==================== 导出 ====================

export default {
  fetch: app.fetch,
  scheduled: app.scheduled
};
