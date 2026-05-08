# Desk Attachment Analyzer

Zoho Desk 工单附件关键词自动分析与打标签功能，基于千问大模型。

## 功能说明

当 Zoho Desk 收到带附件的工单邮件时，自动分析附件内容中的关键词，并为工单打上对应标签。

## 架构

```
Zoho Desk 工作流 → Deluge 自定义函数 → Catalyst 函数 → 千问大模型 API
                                                          ↓
                                      ← 返回匹配关键词/标签 ←
                    ← 更新工单标签 ←
```

## 部署步骤

### 1. 在 Catalyst 中关联此 GitHub 仓库

1. 登录 [Zoho Catalyst Console](https://console.catalyst.zoho.com/)
2. 创建项目 → 项目名填 `desk-attachment-analyzer`
3. 进入项目 → **Settings → Project Configuration → GitHub**
4. 授权 GitHub 账号并选择此仓库
5. Catalyst 会自动识别 `functions/` 目录下的函数

### 2. 配置千问 API Key

在 Catalyst Console 中：
1. 进入项目 → **Cache → Segment**
2. 在 Default Segment 中添加：
   - Key: `QIANWEN_API_KEY`
   - Value: 你的千问 API 密钥

或通过环境变量配置（Settings → Environment Variables）。

### 3. 部署函数

通过 GitHub 集成，push 代码后 Catalyst 会自动部署。

也可以手动部署：
```bash
catalyst deploy
```

### 4. 配置 Zoho Desk 工作流

参考 `docs/deluge_function.dg` 中的 Deluge 代码，在 Desk 中：
1. 创建连接 (Connection) 指向 Zoho Desk API
2. 创建自定义函数，粘贴 Deluge 代码
3. 创建工作流规则，工单创建时触发该函数

## 项目结构

```
desk-attachment-analyzer/
├── catalyst.json              # Catalyst 项目配置
├── catalyst-config.json       # 函数配置
├── functions/
│   └── analyze_attachment/    # Catalyst Advanced I/O 函数
│       ├── index.js           # 主逻辑：调用千问API分析附件
│       └── package.json       # Node.js 依赖
└── docs/
    └── deluge_function.dg     # Zoho Desk Deluge 自定义函数代码
```

## 自定义关键词

在调用 Catalyst 函数时，可以通过 `keywords` 参数传入自定义关键词列表：

```json
{
  "attachmentContent": "附件文本内容...",
  "keywords": ["退款", "投诉", "紧急", "自定义关键词"]
}
```

如果不传 `keywords`，将使用默认关键词列表。

## 返回格式

```json
{
  "success": true,
  "data": {
    "matched_keywords": ["退款", "投诉"],
    "suggested_tags": ["退款处理", "客户投诉"],
    "confidence": "high",
    "summary": "客户要求退款并对服务表示不满"
  }
}
```
