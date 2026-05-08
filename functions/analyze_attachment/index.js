// Zoho Catalyst Advanced I/O Function
// 接收附件内容，调用千问大模型分析关键词，返回匹配的标签

const catalyst = require("zcatalyst-sdk-node");

module.exports = async (req, res) => {
  try {
    const { attachmentContent, keywords } = req.body;

    if (!attachmentContent) {
      return res.status(400).send({ error: "缺少附件内容" });
    }

    // 预定义的关键词列表（也可以从请求中传入）
    const keywordList = keywords || [
      "退款", "投诉", "紧急", "故障", "维修",
      "退货", "换货", "赔偿", "法律", "律师函"
    ];

    // 从 Catalyst Segment（环境变量）中获取千问 API Key
    const app = catalyst.initialize(req);
    let qianwenApiKey;
    try {
      const segment = app.cache().segment();
      qianwenApiKey = await segment.getValue("QIANWEN_API_KEY");
      if (qianwenApiKey) {
        qianwenApiKey = qianwenApiKey.cache_value;
      }
    } catch (e) {
      // fallback 到环境变量
      qianwenApiKey = process.env.QIANWEN_API_KEY;
    }

    if (!qianwenApiKey) {
      return res.status(500).send({ error: "未配置千问API密钥" });
    }

    const prompt = `你是一个工单分类助手。请分析以下邮件附件内容，判断其中是否包含以下任何关键词或相关语义。

关键词列表：${keywordList.join("、")}

附件内容：
${attachmentContent}

请严格按照以下JSON格式返回结果，不要返回其他内容：
{
  "matched_keywords": ["匹配到的关键词1", "匹配到的关键词2"],
  "suggested_tags": ["建议的标签1", "建议的标签2"],
  "confidence": "high/medium/low",
  "summary": "简要描述附件内容"
}`;

    const response = await fetch(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${qianwenApiKey}`,
        },
        body: JSON.stringify({
          model: "qwen-plus",
          messages: [
            {
              role: "system",
              content: "你是一个精确的文本分析助手，只返回JSON格式的结果。",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("千问API调用失败:", errorText);
      return res.status(500).send({ error: "千问API调用失败", detail: errorText });
    }

    const result = await response.json();
    const analysisText = result.choices[0].message.content;

    let analysis;
    try {
      analysis = JSON.parse(analysisText);
    } catch (e) {
      // 如果千问返回的不是纯JSON，尝试提取JSON部分
      const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        analysis = {
          matched_keywords: [],
          suggested_tags: [],
          confidence: "low",
          summary: analysisText,
        };
      }
    }

    res.status(200).send({
      success: true,
      data: analysis,
    });
  } catch (error) {
    console.error("处理异常:", error);
    res.status(500).send({ error: "服务器内部错误", detail: error.message });
  }
};
