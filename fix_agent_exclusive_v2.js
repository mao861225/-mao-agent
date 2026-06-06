require('dotenv').config();

const WP_URL = process.env.WP_URL;
const AUTH = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString('base64');
const HEADERS = { 'Authorization': `Basic ${AUTH}`, 'Content-Type': 'application/json' };

function clean(text) {
  if (!text.includes('獨家') && !text.includes('代理')) return text;

  // Step 1: 由?阿男伍叁[...]代理[...][，。] → 阿男伍叁[，。]
  text = text.replace(/(?:由)?阿男伍叁[^，。\n]*代理[^，。\n]*([，。！？])/g, (_, p) => `阿男伍叁${p}`);

  // Step 2: 阿男伍叁[...](台灣獨家|獨家代理|獨家販售|獨家商品|獨家現貨)[...][，。] → 阿男伍叁[，。]
  text = text.replace(/阿男伍叁[^，。\n]*(台灣獨家|獨家代理|獨家販售|獨家商品|獨家現貨)[^，。\n]*([，。！？])/g, (_, _kw, p) => `阿男伍叁${p}`);

  // Step 3: ，[...]台灣獨家[...][，。] → [，。]（移除夾在兩個標點間的子句）
  text = text.replace(/，[^，。\n]*台灣獨家[^，。\n]*([，。！？])/g, (_, p) => p);

  // Step 4: 其他 [...]台灣獨家[...][，。] → 移除
  text = text.replace(/[^，。\n]*台灣獨家[^，。\n]*[，。！？]?/g, '');

  // Step 5: ，[...]代理[...][，。] → [，。]（剩餘含代理的子句）
  text = text.replace(/，[^，。\n]*代理[^，。\n]*([，。！？])/g, (_, p) => p);

  // Step 6: 剩餘的「獨家」—— 只刪字，保留後面的名詞（如：獨家設計→設計）
  text = text.replace(/獨家\s*/g, '');

  // Step 7: 剩餘的「代理」整段移除
  text = text.replace(/[^，。\n]*代理[^，。\n]*/g, '');

  // 清理標點
  text = text.replace(/[，。！？]{2,}/g, '。');
  text = text.replace(/，。/g, '。');
  text = text.replace(/。，/g, '。');
  text = text.replace(/^\s*[，。！？]+/, '');  // 開頭多餘標點

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

async function updateProduct(id, fields) {
  // WC API 更新 short_description
  if (fields.short_description !== undefined) {
    await fetch(`${WP_URL}/wp-json/wc/v3/products/${id}`, {
      method: 'PUT', headers: HEADERS,
      body: JSON.stringify({ short_description: fields.short_description }),
    });
    await fetch(`${WP_URL}/wp-json/wp/v2/product/${id}`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ excerpt: fields.short_description }),
    });
  }
  // WP API 更新長描述
  if (fields.description !== undefined) {
    await fetch(`${WP_URL}/wp-json/wp/v2/product/${id}`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ content: fields.description }),
    });
  }
}

async function main() {
  console.log('取得所有商品...');
  const products = await fetchAllProducts();

  const log = [];
  let success = 0, failed = 0;

  for (const p of products) {
    const origShort = stripHtml(p.short_description || '');
    const origLong  = stripHtml(p.description || '');
    const fixedShort = clean(origShort);
    const fixedLong  = clean(origLong);

    const shortChanged = fixedShort !== origShort;
    const longChanged  = fixedLong  !== origLong;
    if (!shortChanged && !longChanged) continue;

    const label = `[${p.id}] ${p.name.slice(0, 25)}`;
    try {
      const fields = {};
      if (shortChanged) fields.short_description = fixedShort;
      if (longChanged)  fields.description = fixedLong;
      await updateProduct(p.id, fields);

      if (shortChanged) {
        console.log(`✅ ${label} (短描述)`);
        console.log(`   原：...${origShort.slice(-50)}`);
        console.log(`   改：...${fixedShort.slice(-50)}`);
      }
      if (longChanged) {
        const idx = origLong.indexOf('獨家') !== -1 ? origLong.indexOf('獨家') : origLong.indexOf('代理');
        console.log(`✅ ${label} (長描述)`);
        console.log(`   原：...${origLong.slice(Math.max(0,idx-10), idx+25)}...`);
      }
      console.log('');
      log.push({ id: p.id, name: p.name, shortChanged, longChanged });
      success++;
    } catch (err) {
      console.log(`❌ ${label} → ${err.message}`);
      log.push({ id: p.id, name: p.name, error: err.message });
      failed++;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  const fs = require('fs');
  fs.writeFileSync('./output/fix_v2_log.json', JSON.stringify(log, null, 2), 'utf8');
  console.log(`============================`);
  console.log(`✅ 成功：${success} 個`);
  console.log(`❌ 失敗：${failed} 個`);
}

main().catch(console.error);
