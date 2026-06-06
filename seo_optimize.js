require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const { notify } = require('./notify');

const WP_URL = process.env.WP_URL;
const AUTH = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString('base64');
const HEADERS = { 'Authorization': `Basic ${AUTH}`, 'Content-Type': 'application/json' };
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchAllProducts() {
  const products = [];
  let page = 1;
  console.log('📦 取得所有商品中...');
  while (true) {
    const res = await fetch(
      `${WP_URL}/wp-json/wc/v3/products?per_page=20&page=${page}&status=publish`,
      { headers: HEADERS }
    );
    if (!res.ok) { console.error('取得失敗:', res.status); break; }
    const data = await res.json();
    if (!data.length) break;
    products.push(...data);
    const total = parseInt(res.headers.get('x-wp-total') || '0');
    console.log(`  第 ${page} 頁：${products.length}/${total} 個商品`);
    if (products.length >= total) break;
    page++;
  }
  return products;
}

async function generateSeo(product) {
  const name = product.name || '';
  const shortDesc = stripHtml(product.short_description || '');
  const fullDesc = stripHtml(product.description || '').slice(0, 600);
  const categories = (product.categories || []).map(c => c.name).join('、');

  const prompt = `你是台灣電商 SEO 專家，專門幫棒球裝備品牌「阿男伍叁」優化商品 SEO。
目標市場：台灣，受眾是棒球愛好者、少棒家長、社會人球員。
品牌也代理美國 100% 太陽眼鏡台灣獨家。

商品資訊：
- 名稱：${name}
- 分類：${categories || '棒球裝備'}
- 現有短描述：${shortDesc || '（無）'}
- 商品描述節錄：${fullDesc || '（無）'}

請輸出 JSON（只輸出 JSON，不要其他文字）：
{
  "short_description": "100-130字繁體中文商品短描述，自然帶入1-2個台灣人常搜的關鍵字，說明商品特色與使用情境，結尾可加阿男伍叁品牌名",
  "focus_keyphrase": "4-8字最主要關鍵字（台灣球迷會 Google 的詞）"
}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude 沒有回傳 JSON：${text.slice(0, 100)}`);
  return JSON.parse(jsonMatch[0]);
}

async function updateProduct(productId, seoData) {
  const res = await fetch(`${WP_URL}/wp-json/wc/v3/products/${productId}`, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify({ short_description: `<p>${seoData.short_description}</p>` }),
  });
  return res.ok;
}

async function main() {
  const products = await fetchAllProducts();
  console.log(`\n共 ${products.length} 個商品，開始 SEO 優化...\n`);
  await notify(`🔍 開始 SEO 優化\n共 ${products.length} 個商品`);

  fs.writeFileSync('./output/products_backup.json', JSON.stringify(products, null, 2), 'utf8');
  console.log('✅ 原始資料已備份至 output/products_backup.json\n');

  const log = [];
  let ok = 0, fail = 0;

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const label = `[${i + 1}/${products.length}]`;

    try {
      process.stdout.write(`${label} ${p.name.slice(0, 28).padEnd(28)} `);
      const seo = await generateSeo(p);
      const updated = await updateProduct(p.id, seo);

      log.push({ id: p.id, name: p.name, seo, updated });
      console.log(updated ? `✅ ${seo.focus_keyphrase}` : '⚠️ 更新失敗');
      if (updated) ok++; else fail++;
    } catch (err) {
      console.log(`❌ ${err.message.slice(0, 60)}`);
      log.push({ id: p.id, name: p.name, error: err.message });
      fail++;
    }

    await new Promise(r => setTimeout(r, 400));
  }

  fs.writeFileSync('./output/seo_log.json', JSON.stringify(log, null, 2), 'utf8');
  console.log(`\n============================`);
  console.log(`✅ 成功：${ok}  ❌ 失敗：${fail}`);
  console.log(`📄 詳細記錄：output/seo_log.json`);
  await notify(`✅ SEO 優化完成\n成功 ${ok} 個${fail ? `，失敗 ${fail} 個` : ''}`);
}

main().catch(console.error);
