require('dotenv').config();
const https = require('https');
const readline = require('readline');

const CLIENT_ID = process.env.GSC_CLIENT_ID;
const CLIENT_SECRET = process.env.GSC_CLIENT_SECRET;
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
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
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('請先在 .env 填入 GSC_CLIENT_ID 和 GSC_CLIENT_SECRET');
    process.exit(1);
  }

  console.log('\n請用瀏覽器打開以下網址，並用 m10790205@gmail.com 登入授權：\n');
  console.log(getAuthUrl());
  console.log('\n授權後 Google 會給你一串代碼，複製貼回這裡：');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('授權代碼：', async (code) => {
    rl.close();
    try {
      const tokens = await exchangeCode(code.trim());
      if (tokens.refresh_token) {
        console.log('\n✅ 成功！把這行加入 .env：');
        console.log(`GSC_REFRESH_TOKEN=${tokens.refresh_token}`);
      } else {
        console.log('回傳資料：', JSON.stringify(tokens, null, 2));
        console.log('\n沒有 refresh_token，可能需要重新授權（prompt=consent）');
      }
    } catch (e) {
      console.error('換 token 失敗：', e.message);
    }
  });
}

main();
