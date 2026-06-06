require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const { notify } = require('./notify');

const WP_URL = process.env.WP_URL;
const AUTH = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString('base64');
const HEADERS = { 'Authorization': `Basic ${AUTH}`, 'Content-Type': 'application/json' };
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchAllProducts() {
  const products = [];
  let page = 1;
  console.log('📦 取得所有商品...');
  while (true) {
    const res = await fetch(`${WP_URL}/wp-json/wc/v3/products?per_page=20&page=${page}&status=publish`, { headers: HEADERS });
    const data = await res.json();
    if (!data.length) break;
    products.push(...data);
    const total = parseInt(res.headers.get('x-wp-total') || '0');
    if (products.length >= total) break;
    page++;
  }
  return products;
}

async function generateAltTexts(product, imageCount) {
  const name = product.name || '';
  const categories = (product.categories || []).map(c => c.name).join('、');
  const shortDesc = stripHtml(product.short_description || '').slice(0, 150);

  // 圖片太多時分批，每次最多 10 張
  const batchSize = 10;
  const count = Math.min(imageCount, batchSize);

  const prompt = `你是台灣電商 SEO 專家，幫棒球品牌「阿男伍叁」的商品圖片撰寫 alt text。
目標是讓 Google 圖片搜尋也能找到這些商品。

商品名稱：${name}
分類：${categories || '棒球裝備'}
短描述：${shortDesc || '無'}

請為 ${count} 張圖片生成 alt text，輸出 JSON 陣列（只輸出純 JSON，不要任何其他文字）：
["第1張alt","第2張alt","第3張alt",...]

規則：
- 每張 alt text 不超過 35 字
- 自然包含台灣球迷會搜尋的關鍵字
- 不要重複同樣的文字
- 第1張最重要，要有主關鍵字和阿男伍叁品牌名`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Claude 沒有回傳陣列');
  const alts = JSON.parse(match[0]);
  // 確保數量足夠
  while (alts.length < imageCount) alts.push(`${name} - 阿男伍叁`);
  return alts;
}

async function updateImageAlt(imageId, altText) {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/media/${imageId}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ alt_text: altText }),
  });
  return res.ok;
}

async function main() {
  const products = await fetchAllProducts();
  console.log(`共 ${products.length} 個商品，開始優化圖片 alt text...\n`);
  await notify(`🖼️ 開始圖片 alt text 優化\n共 ${products.length} 個商品`);

  // 收集所有需要更新的圖片（去重，避免同一張圖重複更新）
  const imageMap = new Map(); // imageId → { altText, productName }
  const log = [];
  let updatedImages = 0, skippedImages = 0, errorCount = 0;

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const images = (p.images || []).filter(img => img.id && img.id > 0);
    if (!images.length) continue;

    const label = `[${i + 1}/${products.length}]`;
    try {
      process.stdout.write(`${label} ${p.name.slice(0, 28).padEnd(28)} ${images.length}張圖 → `);

      const alts = await generateAltTexts(p, images.length);

      const result = { id: p.id, name: p.name, images: [] };
      for (let j = 0; j < images.length; j++) {
        const img = images[j];
        if (imageMap.has(img.id)) {
          skippedImages++;
          result.images.push({ imageId: img.id, alt: alts[j], status: 'skipped(shared)' });
          continue;
        }
        const ok = await updateImageAlt(img.id, alts[j]);
        imageMap.set(img.id, { alt: alts[j], product: p.name });
        if (ok) updatedImages++;
        else errorCount++;
        result.images.push({ imageId: img.id, alt: alts[j], status: ok ? 'updated' : 'failed' });
      }

      log.push(result);
      console.log(`✅`);
    } catch (err) {
      console.log(`❌ ${err.message.slice(0, 50)}`);
      log.push({ id: p.id, name: p.name, error: err.message });
      errorCount++;
    }

    await new Promise(r => setTimeout(r, 350));
  }

  fs.writeFileSync('./output/image_alt_log.json', JSON.stringify(log, null, 2), 'utf8');
  console.log(`\n============================`);
  console.log(`🖼️  更新圖片：${updatedImages} 張`);
  console.log(`⏭️  略過（共用圖）：${skippedImages} 張`);
  console.log(`❌ 失敗：${errorCount}`);
  console.log(`📄 記錄：output/image_alt_log.json`);
  await notify(`✅ 圖片 alt text 優化完成\n更新 ${updatedImages} 張${errorCount ? `，失敗 ${errorCount} 張` : ''}`);
}

main().catch(console.error);
