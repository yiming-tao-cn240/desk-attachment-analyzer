# Desk Attachment Analyzer (v2)

Zoho Desk 工单邮件附件智能分析与自动打标签 - 基于千问大模型 + Zoho Catalyst。

支持的附件类型：**TXT / CSV / HTML / EML / JSON / XML / Markdown / PDF / Excel (xlsx,xls) / Word (docx) / 图片 (png,jpg,gif,webp,bmp)**

## 架构

```
Zoho Desk 工作流(工单创建)
   ↓ 仅传 ticketId + orgId
Catalyst Function (analyze_attachment)
   ├─ 用 refresh_token 换取 Desk access_token
   ├─ 拉取工单 threads (direction=in 客户邮件)
   ├─ 下载邮件附件
   ├─ 按类型解析:
   │    PDF      → pdf-parse
   │    Excel    → xlsx
   │    Word     → mammoth
   │    文本类   → utf-8 解码
   │    图片     → 千问 VL 多模态视觉模型
   ├─ 千问大模型分析关键词/标签
   └─ 调用 Desk API 更新工单标签 + 添加内部评论
```

## 部署步骤

### 1. 在 Catalyst 中配置环境变量

进入 **Catalyst Console → Project Settings → Environment Variables**，添加：

| Key | 说明 |
|-----|------|
| `QIANWEN_API_KEY` | 阿里云 DashScope 千问 API Key |
| `ZOHO_CLIENT_ID` | Zoho 自客户端 (Self Client) Client ID |
| `ZOHO_CLIENT_SECRET` | Zoho Self Client Client Secret |
| `ZOHO_REFRESH_TOKEN` | 用 `Desk.tickets.ALL,Desk.settings.ALL` 范围生成的 refresh_token |
| `ZOHO_ACCOUNTS_URL` | 默认 `https://accounts.zoho.com`，国际站为 `.com`，中国站为 `.com.cn` |
| `ZOHO_DESK_BASE` | 默认 `https://desk.zoho.com/api/v1`，中国站为 `https://desk.zoho.com.cn/api/v1` |
| `KEYWORDS` | (可选) 默认关键词列表，用逗号分隔 |

#### 如何生成 Refresh Token

1. 进入 [Zoho API Console](https://api-console.zoho.com/) → 创建 **Self Client**
2. 记录 Client ID / Client Secret
3. 在 **Generate Code** 页面：
   - Scope 填: `Desk.tickets.ALL,Desk.settings.ALL`
   - Time Duration: 10 分钟
4. 取得授权码后，用 curl 换取 refresh_token：
   ```bash
   curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
     -d "grant_type=authorization_code" \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "code=YOUR_CODE"
   ```
5. 把返回的 `refresh_token` 填到 Catalyst 环境变量

### 2. 部署函数

```bash
catalyst deploy
```

### 3. 在 Zoho Desk 创建自定义函数 + 工作流

参考 `docs/deluge_function.dg`：
1. **Setup → Developer Space → Custom Functions** 创建函数 `analyzeTicketAttachments`
   - 参数：`ticketId` (String) → `#Cases.Case Id#`，`orgId` (String) → 你的组织ID
2. **Setup → Automation → Workflows** 创建工单工作流
   - 触发：On Ticket Create
   - 条件：渠道=Email (可选)
   - 动作：执行自定义函数 `analyzeTicketAttachments`

## 项目结构

```
desk-attachment-analyzer/
├── catalyst.json
├── functions/
│   └── analyze_attachment/
│       ├── index.js              # 主逻辑（含 PDF/Excel/Word/图片解析）
│       ├── catalyst-config.json
│       └── package.json
└── docs/
    └── deluge_function.dg        # Desk Deluge 函数（仅传 ticketId）
```

## 接口说明

**请求**
```json
POST /server/analyze_attachment/
{
  "ticketId": "1234567890",
  "orgId": "987654321",
  "keywords": ["可选自定义关键词"]
}
```

**响应**
```json
{
  "success": true,
  "applied": true,
  "tagsApplied": ["退款", "投诉"],
  "processedFiles": ["complaint.pdf", "screenshot.png"],
  "analysis": {
    "matched_keywords": ["退款"],
    "suggested_tags": ["客户投诉"],
    "confidence": "high",
    "summary": "..."
  }
}
```

## 注意事项

- 千问 `qwen-plus` token 上限较大；图片用 `qwen-vl-plus` 多模态模型
- 文本类附件累计截断到 8000 字符；如需更多内容可调整 `index.js` 中阈值
- Catalyst Advanced I/O 函数默认超时 30 秒，附件多/大时建议改用 Cron + Queue 异步处理
- 中国数据中心需把 `ZOHO_ACCOUNTS_URL` / `ZOHO_DESK_BASE` 改为 `.com.cn`
