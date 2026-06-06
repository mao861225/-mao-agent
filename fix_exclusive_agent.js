require('dotenv').config();

const WP_URL = process.env.WP_URL;
const AUTH = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString('base64');
const HEADERS = { 'Authorization': `Basic ${AUTH}`, 'Content-Type': 'application/json' };

function removeExclusiveAgent(text) {
  if (!text.includes('獨家代理')) return text;

  // Step 1: 阿男伍叁[...任意...]獨家代理[...任意...][，。] → 阿男伍叁[，。]
  text = text.replace(/阿男伍叁[^，。\n]*獨家代理[^，。\n]*([，。！？])/g, (_, punct) => `阿男伍叁${punct}`);

  // Step 2: ，[...任意...]獨家代理[...任意...][，。] → [，。]（移除整個子句）
  text = text.replace(/，[^，。\n]*獨家代理[^，。\n]*([，。！？])/g, (_, punct) => punct);

  // Step 3: 剩下獨立的 獨家代理 子句（接在句號後面的情況）
  text = text.replace(/[^，。\n]*獨家代理[^，。\n]*[，。]?/g, '');

  // 清理多餘標點
  text = text.replace(/[，。]{2,}/g, '。');
  text = text.replace(/，。/g, '。');
  text = text.replace(/。，/g, '。');

  return text.trim();
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
}

async function fetchAllProducts() {
  const products = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${WP_URL}/wp-json/wc/v3/products?per_page=50&page=${page}&status=publish`, { headers: HEADERS });
    const data = await res.json();
    if (!data.length) break;
    products.push(...data);
    if (products.length >= parseInt(res.headers.get('x-wp-total') || '0')) break;
    page++;
  }
  return products;
}

async function updateProduct(id, newDesc) {
  // 先試 WC API
  const res = await fetch(`${WP_URL}/wp-json/wc/v3/products/${id}`, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify({ short_description: newDesc }),
  });
  if (!res.ok) throw new Error(`WC API failed: ${res.status}`);

  // 再用 WP API 確保 excerpt 也同步（避免 variable product 問題）
  await fetch(`${WP_URL}/wp-json/wp/v2/product/${id}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ excerpt: newDesc }),
  });
}

async function main() {
  console.log('取得所有商品...');
  const products = await fetchAllProducts();
  console.log(`共 ${products.length} 個商品`);

  const toFix = products.filter(p => {
    const plain = stripHtml(p.short_description || '');
    return plain.includes('獨家代理');
  });
  console.log(`需要修正：${toFix.length} 個商品\n`);

  const log = [];
  let success = 0, failed = 0;

  for (const p of toFix) {
    const original = stripHtml(p.short_description || '');
    const fixed = removeExclusiveAgent(original);
    const label = `[${p.id}] ${p.name.slice(0, 25)}`;

    try {
      await updateProduct(p.id, fixed);
      console.log(`✅ ${label}`);
      console.log(`   原：...${original.slice(-40)}`);
      console.log(`   改：...${fixed.slice(-40)}\n`);
      log.push({ id: p.id, name: p.name, original, fixed, status: 'ok' });
      success++;
    } catch (err) {
      console.log(`❌ ${label} → ${err.message}`);
      log.push({ id: p.id, name: p.name, original, fixed, status: 'failed', error: err.message });
      failed++;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  const fs = require('fs');
  fs.writeFileSync('./output/fix_exclusive_agent_log.json', JSON.stringify(log, null, 2), 'utf8');
  console.log(`\n============================`);
  console.log(`✅ 成功：${success} 個`);
  console.log(`❌ 失敗：${failed} 個`);
  console.log(`📄 記錄：output/fix_exclusive_agent_log.json`);
}

main().catch(console.error);
