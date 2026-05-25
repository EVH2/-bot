-- ClawBot AI 平台 D1 数据库初始化脚本
-- 使用 INTEGER 存储时间戳（strftime('%s','now')）

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,  -- SHA-256 + salt
    email TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'rejected', 'disabled')),
    message_count INTEGER DEFAULT 0,  -- 可用消息数
    invite_code TEXT UNIQUE,  -- 用户专属邀请码
    invited_by INTEGER,  -- 邀请人用户ID
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_login_at INTEGER,
    FOREIGN KEY (invited_by) REFERENCES users(id)
);

-- 智能体表
CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    gender TEXT DEFAULT '女',
    persona TEXT DEFAULT '',  -- 性格设定
    background TEXT DEFAULT '',  -- 背景设定
    inner_thought TEXT DEFAULT '',  -- 内心独白
    actions TEXT DEFAULT '',  -- 动作描述
    speaking_style TEXT DEFAULT '',  -- 说话风格
    rules TEXT DEFAULT '',  -- 规则设定
    custom_prompt TEXT DEFAULT '',  -- 自定义人设
    prefer_short INTEGER DEFAULT 1,  -- 1=短句模式 0=长句模式
    continuous_send INTEGER DEFAULT 0,  -- 是否连续发送
    api_key TEXT,  -- 分配给此智能体的API Key
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
    message_count INTEGER DEFAULT 0,  -- 此智能体对话数
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 对话记录表
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 长期记忆表
CREATE TABLE IF NOT EXISTS long_term_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    agent_id INTEGER NOT NULL,
    memory_type TEXT NOT NULL CHECK(memory_type IN ('preference', 'fact', 'habit', 'conflict')),
    content TEXT NOT NULL,
    confidence REAL DEFAULT 0.5,  -- 置信度 0-1
    source TEXT DEFAULT '',  -- 来源描述
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- 充值记录表
CREATE TABLE IF NOT EXISTS recharge_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,  -- 充值消息条数
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    admin_id INTEGER,  -- 处理的管理员ID
    note TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    processed_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (admin_id) REFERENCES users(id)
);

-- 邀请链接表
CREATE TABLE IF NOT EXISTS invite_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,  -- 邀请码
    creator_id INTEGER NOT NULL,  -- 创建者用户ID
    used_count INTEGER DEFAULT 0,  -- 已使用次数
    reward_messages INTEGER DEFAULT 50,  -- 奖励消息数
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    expires_at INTEGER,  -- 过期时间戳，NULL表示永不过期
    FOREIGN KEY (creator_id) REFERENCES users(id)
);

-- 公告表
CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    priority INTEGER DEFAULT 0,  -- 优先级，数字越大越重要
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'hidden')),
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- 全局配置表
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT DEFAULT '',
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- API Keys 表（存储多个可用的 API Key）
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT UNIQUE NOT NULL,
    api_url TEXT NOT NULL DEFAULT 'https://api.oiapi.net/aiRuntime',
    name TEXT DEFAULT '',  -- Key 名称/备注
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
    use_count INTEGER DEFAULT 0,  -- 使用次数
    last_used_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- 管理员表（单独的管理员账号）
CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'admin' CHECK(role IN ('admin', 'superadmin')),
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- 管理员操作日志
CREATE TABLE IF NOT EXISTS admin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,  -- users/recharges/agents等
    target_id INTEGER,
    detail TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (admin_id) REFERENCES admins(id)
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code);
CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_agent_user ON conversations(agent_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_user_agent ON long_term_memories(user_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_recharge_user ON recharge_records(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invite_links_code ON invite_links(code);

-- 插入默认管理员
-- 默认用户名: admin
-- 默认密码: admin123 (建议首次登录后立即修改)
-- 密码哈希: SHA-256("admin123" + "clawbot_salt") = 请在部署后通过注册接口创建或手动更新
INSERT OR IGNORE INTO admins (id, username, password_hash, role) 
VALUES (1, 'admin', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'superadmin');

-- 插入默认配置
INSERT OR IGNORE INTO config (key, value, description) VALUES 
('default_api_url', 'https://api.oiapi.net/aiRuntime', '默认AI API地址'),
('default_image_api_url', 'https://api.oiapi.net/image', '默认图片API地址'),
('default_image_api_key', '', '默认图片API密钥'),
('wechat_bot_url', '', '微信机器人API地址'),
('wechat_bot_key', '', '微信机器人API密钥'),
('memory_max_count', '500', '每个用户/智能体最大记忆数'),
('morning_push_enabled', 'false', '是否启用早安推送'),
('morning_push_time', '08:00', '早安推送时间(UTC)');
