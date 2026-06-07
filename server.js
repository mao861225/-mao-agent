require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Google OAuth ─────────────────────────────────────────────

const googleAuth = new google.auth.OAuth2(
  process.env.GSC_CLIENT_ID,
  process.env.GSC_CLIENT_SECRET
);
googleAuth.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN || process.env.GSC_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: googleAuth });
const calendar = google.calendar({ version: 'v3', auth: googleAuth });

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

async function queryGSC(params) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GSC_CLIENT_ID,
      client_secret: process.env.GSC_CLIENT_SECRET,
      refresh_token: process.env.GSC_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const { access_token } = await tokenRes.json();
  const siteUrl = encodeURIComponent(process.env.GSC_SITE_URL);
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    }
  );
  return res.json();
}

// ─── Gmail 功能 ───────────────────────────────────────────────

let lastGmailCheck = Date.now();
const processedEmailIds = new Set();

function extractEmailBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8').slice(0, 800);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8').slice(0, 800);
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8')
          .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 800);
      }
    }
  }
  return '';
}

async function analyzeEmail(from, subject, body) {
  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `判斷這封郵件是否為真人寄出且需要回覆（不是廣告、通知、系統信）。
寄件人：${from}
主旨：${subject}
內容：${body.slice(0, 400)}

只回 JSON：{"needsReply":true或false,"summary":"30字內中文摘要"}`
      }]
    });
    return JSON.parse(res.content[0].text.trim());
  } catch {
    return { needsReply: false, summary: '' };
  }
}

async function checkGmail() {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return;
  try {
    const after = Math.floor(lastGmailCheck / 1000);
    lastGmailCheck = Date.now();

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: `after:${after} in:inbox`,
      maxResults: 10
    });

    for (const msg of listRes.data.messages || []) {
      if (processedEmailIds.has(msg.id)) continue;
      processedEmailIds.add(msg.id);

      const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = detail.data.payload.headers;
      const from = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const listUnsub = headers.find(h => h.name === 'List-Unsubscribe')?.value;
      const precedence = headers.find(h => h.name === 'Precedence')?.value;

      if (listUnsub || precedence === 'bulk' || precedence === 'list') continue;
      if (/noreply|no-reply|donotreply|notification|newsletter|mailer-daemon|bounce/i.test(from)) continue;

      const labelIds = detail.data.labelIds || [];
      if (['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'SPAM']
        .some(l => labelIds.includes(l))) continue;

      const body = extractEmailBody(detail.data.payload);
      const analysis = await analyzeEmail(from, subject, body);
      if (!analysis.needsReply) continue;

      await linePush(`📧 新郵件需要回覆\n寄件人：${from}\n主旨：${subject}\n\n摘要：${analysis.summary}`);
    }
  } catch (err) {
    console.error('Gmail 檢查失敗:', err.message);
  }
}

// ─── Calendar 功能 ────────────────────────────────────────────

const TZ = 'Asia/Taipei';

async function getTodayEvents() {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return [];
  const now = new Date();
  const startOfDay = new Date(now.toLocaleDateString('en-CA', { timeZone: TZ }) + 'T00:00:00+08:00');
  const endOfDay = new Date(now.toLocaleDateString('en-CA', { timeZone: TZ }) + 'T23:59:59+08:00');

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: TZ
  });

  return (res.data.items || []).map(e => {
    const start = e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: TZ })
      : '全天';
    return { time: start, title: e.summary || '（無標題）' };
  });
}

async function addCalendarEvent(title, startDateTime, endDateTime, description) {
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: title,
      description: description || '',
      start: { dateTime: startDateTime, timeZone: TZ },
      end: { dateTime: endDateTime, timeZone: TZ }
    }
  });
  return res.data;
}

// ─── 早安報告 ─────────────────────────────────────────────────

async function sendMorningReport() {
  try {
    const events = await getTodayEvents();
    const today = new Date().toLocaleDateString('zh-TW', { timeZone: TZ, month: 'long', day: 'numeric', weekday: 'long' });
    if (events.length === 0) {
      await linePush(`早安！今天 ${today} 沒有行程，祝你順心。`);
    } else {
      const list = events.map(e => `• ${e.time} ${e.title}`).join('\n');
      await linePush(`早安！今天 ${today} 的行程：\n\n${list}`);
    }
  } catch (err) {
    console.error('早安報告失敗:', err.message);
  }
}

function scheduleMorningReport() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(1, 0, 0, 0); // 09:00 台北時間
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(async () => {
    await sendMorningReport();
    scheduleMorningReport();
  }, next - now);
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
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_all_products',
    description: '取得 WordPress 所有上架商品的列表',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '回傳筆數，預設 20' } },
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
    description: '向 Bing/Yahoo 提交 URL 索引請求',
    input_schema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: '要提交的 URL 列表' }
      },
      required: ['urls']
    }
  },
  {
    name: 'add_calendar_event',
    description: '新增 Google Calendar 行程',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '行程標題' },
        startDateTime: { type: 'string', description: '開始時間，ISO 8601 格式（台北時間），例如 2026-06-07T15:00:00+08:00' },
        endDateTime: { type: 'string', description: '結束時間，ISO 8601 格式（台北時間）' },
        description: { type: 'string', description: '行程備註（可選）' }
      },
      required: ['title', 'startDateTime', 'endDateTime']
    }
  },
  {
    name: 'get_today_schedule',
    description: '取得今天的 Google Calendar 行程列表',
    input_schema: { type: 'object', properties: {}, required: [] }
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
      if (!data.rows) return { message: '查無資料' };
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
      const products = await wpRequest(`/products?per_page=${input.limit || 20}&status=publish`);
      return products.map(p => ({
        id: p.id, name: p.name, price: p.price,
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

    if (name === 'add_calendar_event') {
      const event = await addCalendarEvent(
        input.title, input.startDateTime, input.endDateTime, input.description
      );
      return { success: true, title: event.summary, link: event.htmlLink };
    }

    if (name === 'get_today_schedule') {
      const events = await getTodayEvents();
      return { count: events.length, events };
    }

    return { error: `未知工具：${name}` };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Claude Agent ─────────────────────────────────────────────

const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });

const SYSTEM_PROMPT = `你是 Mao 的 AI 助理，協助管理【阿男伍叁】棒球品牌的日常業務與個人行程。
Mao 與維翰共同經營此品牌，販售棒球相關商品與 100% 太陽眼鏡台灣經銷。
官網：https://a-nan53.tw/

你可以執行的任務：
- 查詢 Google Search Console 搜尋數據
- 查詢並更新 WordPress 商品 SEO 短描述
- 提交 URL 到 IndexNow
- 新增 Google Calendar 行程（支援自然語言，如「明天下午3點和維翰開會1小時」）
- 查詢今天的行程

SEO 文案原則：
- 100-130 字，自然帶關鍵字，結尾帶「阿男伍叁」
- 只能描述原始商品介紹已有的內容，禁用「獨家」「代理」等字眼

回應用繁體中文，簡潔自然。今天：${today}（台北時間）`;

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
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
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
  return textBlock ? textBlock.text : '（無回應）';
}

// ─── Webhook 端點 ─────────────────────────────────────────────

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-line-signature'];
  if (!verifySignature(req.body, signature)) return res.status(401).send('Unauthorized');

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

// ─── 啟動 ─────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server 啟動，port ${PORT}`);

  // Gmail 輪詢（每 5 分鐘）
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    setTimeout(checkGmail, 60000);
    setInterval(checkGmail, 5 * 60 * 1000);
    console.log('Gmail 輪詢已啟動');
  }

  // 早安報告排程
  scheduleMorningReport();
  console.log('早安報告排程已啟動');

  // 防止 Render 免費版休眠（每 10 分鐘自 ping）
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) {
    setInterval(() => {
      fetch(selfUrl).catch(() => {});
    }, 10 * 60 * 1000);
    console.log('防休眠 ping 已啟動');
  }
});
