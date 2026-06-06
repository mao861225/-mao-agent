require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── LINE 工具函式 ────────────────────────────────────────────

function verifySignature(rawBody, signature) {
  const hash = crypto
    .createHmac('SHA256', process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hash === signature;
}

async function lineReply(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text: text.slice(0, 5000) }]
    })
  });
}

async function linePush(text) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to: process.env.LINE_USER_ID,
      messages: [{ type: 'text', text: text.slice(0, 5000) }]
    })
  });
}

// ─── WordPress API ────────────────────────────────────────────

const WP_AUTH = 'Basic ' + Buffer.from(
  `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`
).toString('base64');

async function wpRequest(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Authorization': WP_AUTH, 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${process.env.WP_URL}/wp-json/wc/v3${path}`, opts);
  return res.json();
}

// ─── GSC API ─────────────────────────────────────────────────

async function getGSCToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GSC_CLIENT_ID,
      client_secret: process.env.GSC_CLIENT_SECRET,
      refresh_token: process.env.GSC_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  return data.access_token;
}

async function queryGSC(params) {
  const token = await getGSCToken();
  const siteUrl = encodeURIComponent(process.env.GSC_SITE_URL);
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    }
  );
  return res.json();
}

// ─── Tool 定義 ────────────────────────────────────────────────

const tools = [
  {
    name: 'get_gsc_analytics',
    description: '查詢 Google Search Console 搜尋數據，包含關鍵字曝光、點擊、排名、CTR',
    input_schema: {
      type: 'object',
      properties: {
        dimensions: {
          type: 'array',
          items: { type: 'string', enum: ['query', 'page', 'country', 'device'] },
          description: '分組維度：query=關鍵字, page=頁面'
        },
        startDate: { type: 'string', description: '開始日期 YYYY-MM-DD' },
        endDate: { type: 'string', description: '結束日期 YYYY-MM-DD' },
        rowLimit: { type: 'number', description: '回傳筆數，預設 10' }
      },
      required: ['dimensions', 'startDate', 'endDate']
    }
  },
  {
    name: 'get_products_without_seo',
    description: '取得 WordPress 上沒有短描述的商品列表（需要 SEO 優化的商品）',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'update_product_seo',
    description: '更新 WordPress 商品的 SEO 短描述（meta description）',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'number', description: '商品 ID' },
        shortDescription: { type: 'string', description: 'SEO 短描述，100-130 字' }
      },
      required: ['productId', 'shortDescription']
    }
  },
  {
    name: 'submit_indexnow',
    description: '向 Bing/Yahoo 提交 URL 索引請求，讓新商品更快被收錄',
    input_schema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: '要提交的商品 URL 列表'
        }
      },
      required: ['urls']
    }
  },
  {
    name: 'get_all_products',
    description: '取得 WordPress 所有上架商品的列表',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '回傳筆數，預設 20' }
      },
      required: []
    }
  }
];

// ─── Tool 執行 ────────────────────────────────────────────────

async function executeTool(name, input) {
  try {
    if (name === 'get_gsc_analytics') {
      const data = await queryGSC({
        startDate: input.startDate,
        endDate: input.endDate,
        dimensions: input.dimensions,
        rowLimit: input.rowLimit || 10
      });
      if (!data.rows) return { message: '查無資料', raw: data };
      return data.rows.map(r => ({
        keys: r.keys,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: (r.ctr * 100).toFixed(2) + '%',
        position: r.position.toFixed(1)
      }));
    }

    if (name === 'get_products_without_seo') {
      let page = 1, results = [];
      while (true) {
        const products = await wpRequest(`/products?per_page=100&page=${page}&status=publish`);
        if (!Array.isArray(products) || !products.length) break;
        const missing = products.filter(p => !p.short_description || p.short_description.trim() === '');
        results.push(...missing.map(p => ({ id: p.id, name: p.name, permalink: p.permalink })));
        page++;
        if (products.length < 100) break;
      }
      return { count: results.length, products: results };
    }

    if (name === 'get_all_products') {
      const limit = input.limit || 20;
      const products = await wpRequest(`/products?per_page=${limit}&status=publish`);
      return products.map(p => ({
        id: p.id,
        name: p.name,
        price: p.price,
        hasSEO: !!(p.short_description && p.short_description.trim()),
        permalink: p.permalink
      }));
    }

    if (name === 'update_product_seo') {
      const result = await wpRequest(`/products/${input.productId}`, 'PUT', {
        short_description: input.shortDescription
      });
      return { success: true, id: result.id, name: result.name };
    }

    if (name === 'submit_indexnow') {
      const res = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: 'a-nan53.tw',
          key: 'ffeff29e8bdc4c61bc5b84379c33de02',
          keyLocation: 'https://a-nan53.tw/ffeff29e8bdc4c61bc5b84379c33de02.txt',
          urlList: input.urls
        })
      });
      return { status: res.status, submitted: input.urls.length };
    }

    return { error: `未知工具：${name}` };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Claude Agent ─────────────────────────────────────────────

const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });

const SYSTEM_PROMPT = `你是 Mao 的 AI 助理，協助管理【阿男伍叁】棒球品牌的日常業務。
Mao 與維翰共同經營此品牌，販售棒球相關商品與 100% 太陽眼鏡台灣經銷。
官網：https://a-nan53.tw/

你可以執行的任務：
- 查詢 Google Search Console 搜尋數據（關鍵字、頁面曝光、點擊、排名）
- 查詢並更新 WordPress 商品 SEO 短描述
- 提交 URL 到 IndexNow（Bing/Yahoo）

SEO 文案撰寫原則：
- 100-130 字，自然帶關鍵字，結尾帶「阿男伍叁」
- 只能描述原始商品介紹已有的內容，不得加入新概念
- 禁用「獨家」「代理」「正品保證」等字眼（原文沒有的一律不加）

回應用繁體中文，簡潔自然。今天：${today}`;

async function callClaude(userMessage) {
  const messages = [{ role: 'user', content: userMessage }];

  let response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools,
    messages
  });

  while (response.stop_reason === 'tool_use') {
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const toolUse of toolUses) {
      const result = await executeTool(toolUse.name, toolUse.input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result)
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages
    });
  }

  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text : '（無文字回應）';
}

// ─── Webhook 端點 ─────────────────────────────────────────────

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-line-signature'];

  if (!verifySignature(req.body, signature)) {
    return res.status(401).send('Unauthorized');
  }

  // 先回 200 讓 LINE 不超時
  res.json({ status: 'ok' });

  const body = JSON.parse(req.body.toString());

  for (const event of body.events || []) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    if (event.source.userId !== process.env.LINE_USER_ID) continue;

    const text = event.message.text.trim();

    await lineReply(event.replyToken, '收到，處理中...');

    try {
      const result = await callClaude(text);
      await linePush(result);
    } catch (err) {
      console.error('Claude 執行錯誤:', err);
      await linePush(`執行失敗：${err.message}`);
    }
  }
});

app.get('/', (req, res) => res.send('Mao Agent 運作中'));

app.listen(PORT, () => console.log(`Server 啟動，port ${PORT}`));
