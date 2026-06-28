require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const WP_BASE = process.env.WP_URL;
const AUTH = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString('base64');
const HEADERS = { 'Authorization': `Basic ${AUTH}`, 'Content-Type': 'application/json' };
const INDEXNOW_KEY = process.env.INDEXNOW_KEY;
const LINE_TOKEN = process.env.LINE_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function lineNotify(message) {
  if (!LINE_TOKEN || !LINE_USER_ID) return;
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: 'text', text: message }] }),
  }).catch(() => {});
}

async function fetchAllProducts() {
  const products = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${WP_BASE}/wp-json/wc/v3/products?per_page=100&page=${page}&status=publish`,
      { headers: HEADERS }
    );
    if (!res.ok) throw new Error(`取得商品失敗：${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    products.push(...data);
    const total = parseInt(res.headers.get('x-wp-total') || '0');
    if (products.length >= total) break;
    page++;
  }
  return products;
}

async function generateSeo(product) {
  const name = product.name || '';
  const fullDesc = stripHtml(product.description || '').slice(0, 600);
  const categories = (product.categories || []).map(c => c.name).join('、');

  const prompt = `你是台灣電商 SEO 專家，幫棒球裝備品牌「阿男伍叁」優化商品 SEO。
目標市場：台灣，受眾是棒球愛好者、少棒家長、社會人球員。

商品資訊：
- 名稱：${name}
- 分類：${categories || '棒球裝備'}
- 商品描述節錄：${fullDesc || '（無）'}

規則：
- 短描述只能轉換或重新描述商品介紹已有的內容，不得補充原文沒有的特性
- 禁止加入：「獨家」「代理」「正品保證」「官方授權」等字眼（除非原文有）
- 結尾自然帶入「阿男伍叁」品牌名即可

請輸出 JSON（只輸出 JSON，不要其他文字）：
{
  "short_description": "100-130字繁體中文商品短描述，自然帶入1-2個台灣人常搜的關鍵字，說明商品特色與使用情境，結尾帶阿男伍叁品牌名",
  "focus_keyphrase": "4-8字最主要關鍵字"
}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Claude 沒有回傳 JSON：${text.slice(0, 80)}`);
  return JSON.parse(match[0]);
}

async function generateImageAlts(product) {
  const name = product.name || '';
  const images = product.images || [];
  if (!images.length) return [];

  const prompt = `你是 SEO 專家，幫棒球裝備品牌「阿男伍叁」的商品圖片寫 alt text。
商品名稱：${name}
共 ${images.length} 張圖片，第一張要含「阿男伍叁」品牌名，每張不超過 35 字。

只輸出 JSON 陣列（${images.length} 個字串）：
["第1張alt", "第2張alt", ...]`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  return JSON.parse(match[0]);
}

async function updateShortDesc(productId, shortDesc) {
  const res = await fetch(`${WP_BASE}/wp-json/wp/v2/product/${productId}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ excerpt: shortDesc }),
  });
  return res.ok;
}

async function updateImageAlt(mediaId, altText) {
  const res = await fetch(`${WP_BASE}/wp-json/wp/v2/media/${mediaId}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ alt_text: altText }),
  });
  return res.ok;
}

async function submitIndexNow(urls) {
  if (!urls.length || !INDEXNOW_KEY) return;
  await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      host: 'a-nan53.tw',
      key: INDEXNOW_KEY,
      keyLocation: `https://a-nan53.tw/${INDEXNOW_KEY}.txt`,
      urlList: urls,
    }),
  }).catch(() => {});
}

async function main() {
  console.log('開始阿男伍叁 SEO 每日自動化...');

  const allProducts = await fetchAllProducts();
  const newProducts = allProducts.filter(p => !stripHtml(p.short_description || '').trim());

  if (!newProducts.length) {
    console.log('今日無新商品需要優化');
    await lineNotify('阿男伍叁 SEO 每日檢查：今日無新商品需要優化');
    return;
  }

  console.log(`找到 ${newProducts.length} 個新商品需要優化`);
  await lineNotify(`阿男伍叁 SEO：找到 ${newProducts.length} 個新商品，開始優化`);

  const results = [];
  const indexNowUrls = [];

  for (const product of newProducts) {
    console.log(`\n處理：${product.name} (ID: ${product.id})`);
    try {
      const seo = await generateSeo(product);
      console.log(`  短描述關鍵字：${seo.focus_keyphrase}`);

      const descOk = await updateShortDesc(product.id, seo.short_description);
      console.log(`  短描述更新：${descOk ? 'OK' : '失敗'}`);
      await new Promise(r => setTimeout(r, 300));

      const images = (product.images || []).filter(img => !img.alt);
      if (images.length) {
        const alts = await generateImageAlts(product);
        const uniqueIds = [...new Set(images.map(img => img.id))];
        for (let i = 0; i < uniqueIds.length; i++) {
          if (alts[i]) {
            await updateImageAlt(uniqueIds[i], alts[i]);
            await new Promise(r => setTimeout(r, 300));
          }
        }
        console.log(`  圖片 alt 更新：${uniqueIds.length} 張`);
      }

      const permalink = (product.permalink || '').replace(
        'twm10790205681.admin.metabiz.tw', 'a-nan53.tw'
      );
      if (permalink) indexNowUrls.push(permalink);

      results.push({ id: product.id, name: product.name, keyphrase: seo.focus_keyphrase, ok: descOk });
    } catch (err) {
      console.error(`  錯誤：${err.message}`);
      results.push({ id: product.id, name: product.name, error: err.message });
    }
  }

  await submitIndexNow(indexNowUrls);

  const ok = results.filter(r => r.ok).length;
  const fail = results.filter(r => r.error).length;
  const summary = results.map(r => r.error
    ? `✗ ${r.name}：${r.error.slice(0, 30)}`
    : `✓ ${r.name}（${r.keyphrase}）`
  ).join('\n');

  console.log(`\n完成：成功 ${ok}，失敗 ${fail}`);
  await lineNotify(`阿男伍叁 SEO 完成\n成功 ${ok}，失敗 ${fail}\n\n${summary}`);
}

main().catch(async err => {
  console.error('執行失敗：', err.message);
  await lineNotify(`阿男伍叁 SEO 執行失敗：${err.message}`);
  process.exit(1);
});
