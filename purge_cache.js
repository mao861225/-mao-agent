require('dotenv').config();
const { notify } = require('./notify');

const WP_URL = process.env.WP_URL;
const AUTH = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString('base64');
const HEADERS = { 'Authorization': `Basic ${AUTH}`, 'Content-Type': 'application/json' };

async function fetchAllProductIds() {
  const ids = [];
  let page = 1;
  while (true) {
    const r = await fetch(`${WP_URL}/wp-json/wc/v3/products?per_page=100&page=${page}&status=publish&_fields=id`, { headers: HEADERS });
    const data = await r.json();
    if (!data.length) break;
    ids.push(...data.map(p => p.id));
    const total = parseInt(r.headers.get('x-wp-total') || '0');
    if (ids.length >= total) break;
    page++;
  }
  return ids;
}

async function touchProduct(id) {
  // 寫入一個隱藏 meta，觸發 save_post → wp-cloudflare-page-cache 自動清該商品快取
  const r = await fetch(`${WP_URL}/wp-json/wc/v3/products/${id}`, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify({
      meta_data: [{ key: '_cache_purged_at', value: String(Date.now()) }]
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

async function main() {
  await notify('🔄 開始清除網站快取...');

  console.log('取得所有商品 ID...');
  const ids = await fetchAllProductIds();
  console.log(`共 ${ids.length} 個商品，開始觸發快取清除...\n`);

  let success = 0, failed = 0;

  for (const id of ids) {
    try {
      await touchProduct(id);
      process.stdout.write(`✅ ${id}  `);
      success++;
    } catch (err) {
      process.stdout.write(`❌ ${id}(${err.message})  `);
      failed++;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n\n完成：成功 ${success} 個，失敗 ${failed} 個`);
  await notify(`✅ 快取清除完成\n共 ${ids.length} 個商品，成功 ${success} 個${failed ? `，失敗 ${failed} 個` : ''}`);
}

main().catch(console.error);
