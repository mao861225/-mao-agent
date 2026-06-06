require('dotenv').config();
const https = require('https');
const { notify } = require('./notify');

const CLIENT_ID = process.env.GSC_CLIENT_ID;
const CLIENT_SECRET = process.env.GSC_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GSC_REFRESH_TOKEN;
const SITE_URL = process.env.GSC_SITE_URL;

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const options = {
      hostname, path, method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }).toString();

  const result = await httpsPost('oauth2.googleapis.com', '/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);

  if (!result.access_token) throw new Error('無法取得 access token: ' + JSON.stringify(result));
  return result.access_token;
}

async function queryGsc(accessToken, startDate, endDate, dimensions) {
  return httpsPost(
    'searchconsole.googleapis.com',
    `/webmasters/v3/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`,
    { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
    { startDate, endDate, dimensions, rowLimit: 10 }
  );
}

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function fmt(n, decimals = 0) {
  return Number(n).toFixed(decimals);
}

function trend(now, prev) {
  if (!prev || prev === 0) return '';
  const pct = ((now - prev) / prev) * 100;
  if (Math.abs(pct) < 3) return '（持平）';
  return pct > 0 ? `（↑${fmt(pct)}%）` : `（↓${fmt(Math.abs(pct))}%）`;
}

async function main() {
  const token = await getAccessToken();

  // 昨天 vs 上週同天
  const yesterday = dateStr(1);
  const twoDaysAgo = dateStr(2);
  const eightDaysAgo = dateStr(8);
  const nineDaysAgo = dateStr(9);

  // 近 7 天 vs 前 7 天
  const week1End = dateStr(1);
  const week1Start = dateStr(7);
  const week2End = dateStr(8);
  const week2Start = dateStr(14);

  const [week1, week2, topKeywords, topPages] = await Promise.all([
    queryGsc(token, week1Start, week1End, ['date']),
    queryGsc(token, week2Start, week2End, ['date']),
    queryGsc(token, week1Start, week1End, ['query']),
    queryGsc(token, week1Start, week1End, ['page']),
  ]);

  // 加總近 7 天
  const sum = (rows) => (rows || []).reduce((acc, r) => ({
    clicks: acc.clicks + r.clicks,
    impressions: acc.impressions + r.impressions,
    ctr: 0,
    position: 0,
    count: acc.count + 1,
    posSum: acc.posSum + r.position * r.impressions,
    impSum: acc.impSum + r.impressions,
  }), { clicks: 0, impressions: 0, count: 0, posSum: 0, impSum: 0 });

  const w1 = sum(week1.rows);
  const w2 = sum(week2.rows);
  const w1Ctr = w1.impressions ? (w1.clicks / w1.impressions * 100) : 0;
  const w2Ctr = w2.impressions ? (w2.clicks / w2.impressions * 100) : 0;
  const w1Pos = w1.impSum ? (w1.posSum / w1.impSum) : 0;
  const w2Pos = w2.impSum ? (w2.posSum / w2.impSum) : 0;

  // 前 10 關鍵字
  const keywords = (topKeywords.rows || []).slice(0, 5).map((r, i) =>
    `  ${i + 1}. ${r.keys[0]}｜點擊 ${r.clicks}，排名約第 ${fmt(r.position)} 位`
  ).join('\n');

  // 前 5 頁面
  const pages = (topPages.rows || []).slice(0, 5).map((r, i) => {
    const slug = r.keys[0].replace('https://a-nan53.tw', '') || '/';
    return `  ${i + 1}. ${slug}｜點擊 ${r.clicks}`;
  }).join('\n');

  // 建議
  const suggestions = [];
  if (w1.clicks < w2.clicks * 0.9) suggestions.push('點擊數下滑，可以考慮在主力商品的短描述加入更吸引人的行動號召。');
  if (w1Pos > w2Pos + 1) suggestions.push('平均排名退步，建議檢查最近有沒有商品或文章被下架或修改。');
  if (w1Ctr < w2Ctr - 1) suggestions.push('點擊率下降，代表出現在搜尋結果但沒人點，可以試著改寫標題或短描述讓它更吸引人。');
  if (suggestions.length === 0) suggestions.push('數據穩定，繼續維持現有策略，可考慮新增商品相關文章來擴大曝光。');

  const msg = `📊 阿男伍叁 GSC 每日報告（近 7 天）

🔢 整體數據
  曝光：${w1.impressions} ${trend(w1.impressions, w2.impressions)}
  點擊：${w1.clicks} ${trend(w1.clicks, w2.clicks)}
  點擊率：${fmt(w1Ctr, 1)}% ${trend(w1Ctr, w2Ctr)}
  平均排名：第 ${fmt(w1Pos, 1)} 位 ${w2Pos ? trend(-w1Pos, -w2Pos) : ''}

🔑 熱門關鍵字（前 5）
${keywords || '  （尚無資料）'}

📄 熱門頁面（前 5）
${pages || '  （尚無資料）'}

💡 建議
${suggestions.map(s => '  • ' + s).join('\n')}`;

  console.log(msg);
  await notify(msg);
}

main().catch(async (e) => {
  const errMsg = '❌ GSC 報告失敗：' + e.message;
  console.error(errMsg);
  await notify(errMsg);
});
