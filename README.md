# ClawBot AI 角色扮演平台 - 部署指南

基于 Cloudflare Workers + D1 + Pages 零成本部署方案

## 📁 项目结构

```
ClawBot_SaaS平台_CF/
├── schema.sql          # D1 数据库初始化脚本
├── worker.js           # Cloudflare Worker 入口
├── wrangler.toml       # Wrangler 配置
├── package.json        # Node.js 依赖
├── README.md           # 部署文档（本文件）
└── frontend/          # 前端静态文件
    ├── index.html      # 首页
    ├── register.html   # 注册页
    ├── login.html      # 登录页
    ├── dashboard.html  # 用户控制台
    ├── create_agent.html  # 创建/编辑智能体
    ├── invite.html     # 邀请页面
    ├── recharge.html   # 充值页面
    ├── admin/
    │   ├── login.html  # 管理员登录
    │   └── dashboard.html  # 管理后台
    ├── js/
    │   └── api.js      # API 请求工具
    └── css/
        └── style.css   # 全局样式
```

## 🚀 部署步骤

### 1. 前置准备

- 注册 [Cloudflare](https://cloudflare.com) 账号
- 安装 Node.js (v16+)
- 安装 Wrangler CLI：`npm install -g wrangler`

### 2. 初始化 Cloudflare 项目

```bash
# 登录 Cloudflare
wrangler login

# 创建 D1 数据库
wrangler d1 create clawbot-db

# 创建 KV 命名空间（可选，用于缓存）
wrangler kv:namespace create CLAWBOT_CACHE
```

### 3. 更新配置文件

编辑 `wrangler.toml`，填入实际的 D1 数据库 ID：

```toml
[[d1_databases]]
binding = "DB"
database_name = "clawbot-db"
database_id = "YOUR_ACTUAL_D1_DATABASE_ID"  # 替换这里
```

### 4. 初始化数据库

```bash
# 本地测试
wrangler d1 execute clawbot-db --local --file=./schema.sql

# 部署到生产
wrangler d1 execute clawbot-db --remote --file=./schema.sql
```

### 5. 生成管理员账号

数据库初始化后，需要创建管理员密码哈希。使用以下命令生成：

```javascript
// 在浏览器控制台执行
const password = 'admin123'; // 你的密码
const salt = 'clawbot_salt';
const hash = await crypto.subtle.digest('SHA-256', 
  new TextEncoder().encode(password + salt));
console.log(Array.from(new Uint8Array(hash))
  .map(b => b.toString(16).padStart(2, '0')).join(''));
```

然后更新数据库：

```bash
wrangler d1 execute clawbot-db --remote --command="
  UPDATE admins SET password_hash = '你的哈希值' WHERE username = 'admin';
"
```

### 6. 配置环境变量

在 Cloudflare Dashboard 中设置以下环境变量：

| 变量名 | 说明 | 示例 |
|--------|------|------|
| JWT_SECRET | JWT 签名密钥 | 生成一个随机字符串 |
| DEFAULT_REWARD_MESSAGES | 邀请奖励消息数 | 50 |

### 7. 部署 Worker

```bash
# 部署到生产
wrangler deploy

# 或开发模式测试
wrangler dev
```

### 8. 部署前端到 Cloudflare Pages

```bash
# 使用 Wrangler 部署
wrangler pages deploy ./frontend --project-name=clawbot-saas

# 或使用 GitHub 集成（推荐）
# 在 Cloudflare Dashboard 中创建 Pages 项目
# 连接 GitHub 仓库，设置构建命令和输出目录
```

### 9. 配置自定义域名（可选）

在 Cloudflare Dashboard 中：
1. 进入 Pages 项目设置
2. 添加自定义域名
3. 配置 DNS 记录

## 🔧 配置说明

### AI API 配置

在管理后台的「API配置」中添加可用的 AI API Key：

```json
{
  "api_key": "sk-your-api-key",
  "api_url": "https://api.oiapi.net/aiRuntime",
  "name": "主 API"
}
```

### 微信机器人配置

在「系统配置」中设置微信机器人 API：

| 配置项 | 说明 |
|--------|------|
| wechat_bot_url | 微信机器人 API 地址 |
| wechat_bot_key | 微信机器人 API 密钥 |

### 早安推送配置

1. 在「系统配置」中启用早安推送
2. 配置微信机器人
3. Worker 会每天 8:00 UTC 自动执行

## 📱 功能说明

### 用户端

- **注册/登录**：支持邀请链接注册
- **创建智能体**：自定义角色人设、性格、说话风格等
- **对话功能**：支持普通模式和连续发送模式
- **长期记忆**：AI 会记住对话内容并学习用户偏好
- **充值系统**：申请充值，管理员审核
- **邀请系统**：生成邀请链接，邀请好友获得奖励

### 管理端

- **数据概览**：查看平台整体数据
- **用户管理**：审核用户、设置额度、停用/启用
- **充值管理**：审核充值申请
- **API 配置**：管理 AI API Keys，支持批量导入
- **邀请链接**：生成和管理邀请链接
- **公告管理**：发布平台公告
- **系统配置**：配置微信机器人、早安推送等

## 🔒 安全建议

1. **修改默认管理员密码**：首次部署后立即修改
2. **设置强 JWT 密钥**：使用随机字符串
3. **定期备份数据库**：`wrangler d1 export`
4. **启用 HTTPS**：Cloudflare 自动提供

## 💰 成本

- **Cloudflare Workers**：免费（每天 100,000 请求）
- **Cloudflare D1**：免费（每天 5,000,000 行读取）
- **Cloudflare Pages**：免费（无限带宽）
- **总计**：$0 / 月

## 🐛 常见问题

### Q: 部署后无法访问？

1. 检查 Worker 是否部署成功
2. 检查 D1 数据库绑定是否正确
3. 检查 Pages 项目的自定义域名配置

### Q: AI 对话无响应？

1. 检查 API Key 是否正确配置
2. 检查 API 地址是否可访问
3. 查看 Worker 日志排查问题

### Q: 记忆功能不工作？

1. 检查 D1 数据库连接
2. 检查 memory_max_count 配置
3. 确认 AI API 返回格式正确

## 📞 支持

如有问题，请提交 Issue 或联系开发者。

---

**祝部署顺利！🎉**




