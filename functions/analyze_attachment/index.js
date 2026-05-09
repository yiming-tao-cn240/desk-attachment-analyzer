// ============================================================
// Zoho Catalyst Advanced I/O Function
// 输入: { ticketId, orgId }
// 流程:
//   1. 用 refresh_token 换取 Desk access_token
//   2. 获取工单 threads，找到客户(direction=in)的邮件
//   3. 下载所有附件 (二进制安全)
//   4. 按类型解析:
//        - 文本 (txt/csv/html/eml/json/xml/md) → 直接读
//        - PDF                              → pdf-parse
//        - Excel (xlsx/xls)                 → xlsx
//        - Word (docx)                      → mammoth
//        - 图片 (png/jpg/jpeg/gif/webp/bmp) → 千问 VL 多模态
//   5. 调用千问大模型分析关键词 / 建议标签
//   6. 通过 Desk API 给工单打标签 + 添加内部评论
// ============================================================

const fetch = global.fetch;
const catalyst = require("zcatalyst-sdk-node");
const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");
const mammoth = require("mammoth");

// ---------- 环境变量 ----------
const QIANWEN_API_KEY = process.env.QIANWEN_API_KEY;
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com";
const ZOHO_DESK_BASE = process.env.ZOHO_DESK_BASE || "https://desk.zoho.com/api/v1";

// 默认关键词 (可通过 Catalyst 环境变量 KEYWORDS 覆盖, 用逗号分隔)
const DEFAULT_KEYWORDS = (process.env.KEYWORDS ||
  "退款,投诉,紧急,故障,维修,退货,换货,赔偿,法律,律师函"
).split(",").map(s => s.trim()).filter(Boolean);

// 文件类型分类
const TEXT_EXTS = ["txt", "csv", "html", "htm", "eml", "json", "xml", "md", "log"];
const PDF_EXTS = ["pdf"];
const EXCEL_EXTS = ["xlsx", "xls"];
const WORD_EXTS = ["docx"];
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

// ---------- Token 持久化 (Catalyst Cache) ----------
// Catalyst Cache 默认 segment, key 名
const TOKEN_CACHE_KEY = "desk_access_token";
// access_token 实际有效期 1 小时, 提前 5 分钟过期, 即缓存 55 分钟
const TOKEN_CACHE_TTL_HOURS = 1; // Cache TTL 单位为小时, 最小 1 小时

function getCacheSegment(req) {
  const app = catalyst.initialize(req);
  return app.cache().segment();
}

async function fetchNewAccessToken() {
  const url = `${ZOHO_ACCOUNTS_URL}/oauth/v2/token` +
    `?refresh_token=${encodeURIComponent(ZOHO_REFRESH_TOKEN)}` +
    `&client_id=${encodeURIComponent(ZOHO_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(ZOHO_CLIENT_SECRET)}` +
    `&grant_type=refresh_token`;
  const resp = await fetch(url, { method: "POST" });
  const data = await resp.json();
  if (!data.access_token) throw new Error("获取 Desk access_token 失败: " + JSON.stringify(data));
  return data.access_token;
}

// 获取 Token: 优先从 Cache 读, 没有/失效则刷新并写回
async function getDeskAccessToken(req, forceRefresh = false) {
  const segment = getCacheSegment(req);

  if (!forceRefresh) {
    try {
      // segment.get(key) 返回 { cache_name, cache_value, expires_in, ... }
      // segment.getValue(key) 直接返回字符串值本身
      const cachedValue = await segment.getValue(TOKEN_CACHE_KEY);
      if (cachedValue && typeof cachedValue === "string") {
        console.log("[Token Cache] HIT, 使用缓存 token");
        return cachedValue;
      }
    } catch (e) {
      // key 不存在时会抛错, 正常忽略
      console.log("[Token Cache] MISS:", e.message);
    }
  } else {
    console.log("[Token Cache] 强制刷新");
  }

  const newToken = await fetchNewAccessToken();
  console.log("[Token Cache] 已从 Zoho 获取新 token, 写入缓存");

  try {
    // put 在 key 已存在时会冲突, 先删除
    try { await segment.delete(TOKEN_CACHE_KEY); } catch (_) {}
    await segment.put(TOKEN_CACHE_KEY, newToken, TOKEN_CACHE_TTL_HOURS);
  } catch (e) {
    console.error("[Token Cache] 写入失败 (不影响本次请求):", e.message);
  }
  return newToken;
}

// ---------- 工具: 调用 Desk API (含 401 自动刷新重试) ----------
async function deskApi(req, orgId, path, options = {}) {
  const doFetch = async (token) => {
    const headers = {
      Authorization: `Zoho-oauthtoken ${token}`,
      orgId: orgId,
      ...(options.headers || {}),
    };
    return fetch(`${ZOHO_DESK_BASE}${path}`, { ...options, headers });
  };

  let token = await getDeskAccessToken(req);
  let resp = await doFetch(token);

  // Token 过期/失效, 强制刷新一次
  if (resp.status === 401) {
    token = await getDeskAccessToken(req, true);
    resp = await doFetch(token);
  }
  return resp;
}

// ---------- 解析附件内容 ----------
async function parseAttachment(buffer, ext) {
  if (TEXT_EXTS.includes(ext)) {
    return buffer.toString("utf-8");
  }
  if (PDF_EXTS.includes(ext)) {
    const data = await pdfParse(buffer);
    return data.text || "";
  }
  if (EXCEL_EXTS.includes(ext)) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    let text = "";
    wb.SheetNames.forEach(name => {
      const sheet = wb.Sheets[name];
      text += `\n[Sheet: ${name}]\n${XLSX.utils.sheet_to_csv(sheet)}\n`;
    });
    return text;
  }
  if (WORD_EXTS.includes(ext)) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }
  return ""; // 其它类型不在这里处理（图片走多模态分支）
}

// ---------- 调用千问纯文本模型 ----------
async function qianwenAnalyze(content, keywords) {
  const prompt = `你是一个工单分类助手。请分析以下邮件附件内容，判断其中是否包含以下任何关键词。

关键词列表：${keywords.join("、")}

附件内容：
${content}

请严格按照以下JSON格式返回，不要返回其他内容：
{
  "matched_keywords": ["匹配到的关键词"],
  "suggested_tags": ["建议的标签"],
  "confidence": "high/medium/low",
  "summary": "简要描述附件内容"
}`;

  const resp = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${QIANWEN_API_KEY}`,
    },
    body: JSON.stringify({
      model: "qwen-plus",
      messages: [
        { role: "system", content: "你是精确的文本分析助手，只返回JSON。" },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });
  const data = await resp.json();
  return parseLLMJson(data?.choices?.[0]?.message?.content);
}

// ---------- 调用千问多模态模型 (图片识别) ----------
async function qianwenVisionAnalyze(imageBase64, mimeType, keywords) {
  const prompt = `请分析这张图片内容，判断其中是否包含以下任何关键词：${keywords.join("、")}。

请严格返回JSON：
{
  "matched_keywords": ["匹配关键词"],
  "suggested_tags": ["建议标签"],
  "confidence": "high/medium/low",
  "summary": "图片内容描述"
}`;

  const resp = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${QIANWEN_API_KEY}`,
    },
    body: JSON.stringify({
      model: "qwen-vl-plus",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            { type: "text", text: prompt },
          ],
        },
      ],
      temperature: 0.1,
    }),
  });
  const data = await resp.json();
  return parseLLMJson(data?.choices?.[0]?.message?.content);
}

// ---------- 解析 LLM 返回 JSON ----------
function parseLLMJson(text) {
  if (!text) return { matched_keywords: [], suggested_tags: [], confidence: "low", summary: "" };
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return { matched_keywords: [], suggested_tags: [], confidence: "low", summary: text.slice(0, 200) };
  }
}

// ---------- 合并多次分析结果 ----------
function mergeAnalyses(list) {
  const tagSet = new Set();
  const kwSet = new Set();
  const summaries = [];
  let confidence = "low";
  const order = { low: 0, medium: 1, high: 2 };
  for (const a of list) {
    (a.matched_keywords || []).forEach(k => kwSet.add(k));
    (a.suggested_tags || []).forEach(t => tagSet.add(t));
    if (a.summary) summaries.push(a.summary);
    if (order[a.confidence] > order[confidence]) confidence = a.confidence;
  }
  return {
    matched_keywords: [...kwSet],
    suggested_tags: [...tagSet],
    confidence,
    summary: summaries.join(" | "),
  };
}

// ---------- 工具: 兼容 Catalyst 原生 http.ServerResponse 的 JSON 响应 ----------
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------- 工具: 读取 req body (原生 http 不会自动解析) ----------
// ⚠️ Zoho ID 是 18 位长整型, 超过 Number.MAX_SAFE_INTEGER (2^53)
// 直接 JSON.parse 会丢失精度 (例如 ...818 变成 ...800)
// 所以解析前先把所有 16+ 位裸数字加上引号变成字符串
function safeJsonParse(text) {
  if (!text) return {};
  const safe = text.replace(/:\s*(\d{16,})(\s*[,}])/g, ': "$1"$2');
  try { return JSON.parse(safe); } catch { return {}; }
}

async function readJsonBody(req) {
  if (req.body) {
    if (typeof req.body === "string") {
      return safeJsonParse(req.body);
    }
    return req.body;
  }
  return new Promise((resolve) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => resolve(safeJsonParse(data)));
    req.on("error", () => resolve({}));
  });
}

// ============================================================
// 主入口
// ============================================================
module.exports = async (req, res) => {
  try {
    const body = await readJsonBody(req);
    const { ticketId, orgId, keywords } = body || {};
    if (!ticketId || !orgId || String(ticketId).trim() === "" || String(orgId).trim() === "") {
      return sendJson(res, 400, {
        error: "缺少 ticketId 或 orgId",
        received: { ticketId, orgId },
        hint: "Deluge 手动测试时请确保 ticketId 已赋值；工作流触发时应映射 #Cases.Case Id#",
      });
    }
    const keywordList = Array.isArray(keywords) && keywords.length ? keywords : DEFAULT_KEYWORDS;

    // 1. 获取 threads (内部会从 Cache 读 token, 过期自动刷新)
    const threadsPath = `/tickets/${ticketId}/threads`;
    const threadsResp = await deskApi(req, orgId, threadsPath);
    if (!threadsResp.ok) {
      return sendJson(res, 500, {
        error: "获取 threads 失败",
        status: threadsResp.status,
        url: `${ZOHO_DESK_BASE}${threadsPath}`,
        orgId: String(orgId),
        ticketId: String(ticketId),
        detail: await threadsResp.text(),
      });
    }
    const threadsData = await threadsResp.json();
    const inThreads = (threadsData.data || []).filter(t => t.direction === "in");
    if (inThreads.length === 0) {
      return sendJson(res, 200, { success: true, skipped: true, reason: "没有客户邮件线程" });
    }

    // 2. 收集所有客户邮件附件
    const analyses = [];
    let textBuffer = "";
    const processedFiles = [];

    for (const thread of inThreads) {
      const detailResp = await deskApi(req, orgId, `/tickets/${ticketId}/threads/${thread.id}`);
      if (!detailResp.ok) continue;
      const detail = await detailResp.json();
      const attachments = detail.attachments || [];

      for (const att of attachments) {
        const ext = (att.name || "").split(".").pop().toLowerCase();
        const fileResp = await deskApi(req, orgId,
          `/tickets/${ticketId}/threads/${thread.id}/attachments/${att.id}/content`);
        if (!fileResp.ok) continue;
        const arrayBuf = await fileResp.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        processedFiles.push(att.name);

        try {
          if (IMAGE_EXTS.includes(ext)) {
            // 图片走多模态
            const mime = att.contentType || `image/${ext === "jpg" ? "jpeg" : ext}`;
            const analysis = await qianwenVisionAnalyze(buffer.toString("base64"), mime, keywordList);
            analyses.push(analysis);
          } else {
            const text = await parseAttachment(buffer, ext);
            if (text && text.trim()) {
              textBuffer += `\n--- 附件: ${att.name} ---\n${text}\n`;
            }
          }
        } catch (e) {
          console.error(`解析附件 ${att.name} 失败:`, e.message);
        }
      }
    }

    // 3. 文本类一次性分析
    if (textBuffer.trim()) {
      const truncated = textBuffer.length > 8000 ? textBuffer.slice(0, 8000) : textBuffer;
      analyses.push(await qianwenAnalyze(truncated, keywordList));
    }

    if (analyses.length === 0) {
      return sendJson(res, 200, { success: true, skipped: true, reason: "没有可分析的附件", processedFiles });
    }

    // 4. 合并结果
    const merged = mergeAnalyses(analyses);
    const allTags = [...new Set([...merged.matched_keywords, ...merged.suggested_tags])];

    // 5. 添加内部评论 (标签由 Deluge 端处理)
    const commentBody = {
      content:
        `【AI附件分析】\n` +
        `- 处理文件: ${processedFiles.join(", ")}\n` +
        `- 匹配关键词: ${merged.matched_keywords.join(", ")}\n` +
        `- 建议标签: ${merged.suggested_tags.join(", ")}\n` +
        `- 置信度: ${merged.confidence}\n` +
        `- 摘要: ${merged.summary}`,
      isPublic: false,
      contentType: "plainText",
    };
    await deskApi(req, orgId, `/tickets/${ticketId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(commentBody),
    });

    // 6. 把分析结果返回给 Deluge, 由 Deluge 端去更新工单标签
    sendJson(res, 200, {
      success: true,
      tags: allTags,
      matched_keywords: merged.matched_keywords,
      suggested_tags: merged.suggested_tags,
      confidence: merged.confidence,
      summary: merged.summary,
      processedFiles,
    });
  } catch (err) {
    console.error("处理异常:", err);
    sendJson(res, 500, { error: "服务器内部错误", detail: err.message });
  }
};

