require('dotenv').config();
const readline = require('readline');

const CLIENT_ID = process.env.GSC_CLIENT_ID;
const CLIENT_SECRET = process.env.GSC_CLIENT_SECRET;
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar',
].join(' ');

const params = new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPES,
  access_type: 'offline',
  prompt: 'consent',
});

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

console.log('\n請用瀏覽器打開以下網址，用 m10790205@gmail.com 授權：\n');
console.log(authUrl);
console.log('\n授權後 Google 會給一串代碼，複製貼回這裡：');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('授權代碼：', async (code) => {
  rl.close();
  const body = new URLSearchParams({
    code: code.trim(),
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const tokens = await res.json();

  if (tokens.refresh_token) {
    console.log('\n✅ 成功！把這行加入 .env：');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  } else {
    console.log('回傳：', JSON.stringify(tokens, null, 2));
  }
});
