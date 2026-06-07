require('dotenv').config();
const express = require('express');
const path = require('path');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

const googleAuth = new google.auth.OAuth2(
  process.env.GSC_CLIENT_ID,
  process.env.GSC_CLIENT_SECRET
);
googleAuth.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN || process.env.GSC_REFRESH_TOKEN
});
const gmail = google.gmail({ version: 'v1', auth: googleAuth });

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get(['/builder/baseball', '/builder/baseball/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'glove-builder.html'));
});

app.get('/', (req, res) => {
  res.redirect('/builder/baseball');
});

async function sendEmail(to, subject, body) {
  const msg = [
    `To: ${to}`,
    `From: 阿男伍叁 <m10790205@gmail.com>`,
    'Content-Type: text/plain; charset=UTF-8',
    'MIME-Version: 1.0',
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    '',
    body
  ].join('\r\n');
  const encoded = Buffer.from(msg).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
}

app.post('/order', async (req, res) => {
  try {
    const o = req.body;
    const zoneLines = Object.entries(o.colors || {})
      .map(([k, v]) => `  ${k}: ${v}`).join('\n');
    const detail = `慣用手：${o.hand}　尺寸：${o.size}　網型：${o.web}　硬度：${o.stiffness}\n\n顏色配置：\n${zoneLines}\n\n拇指刺繡：${o.thumbText || '—'}\n尾指刺繡：${o.pinkyText || '—'}\n掌心印字：${o.palmText || '—'}\n腕帶文字：${o.wristText || '—'}\n特殊需求：${o.specialNotes || '—'}`;
    const body = `【新客製手套訂單】\n\n客戶：${o.customerName}\nEmail：${o.customerEmail}\n電話：${o.customerPhone || '—'}\n\n${detail}`;

    await sendEmail('ananfitythree@gmail.com', `新客製手套訂單 - ${o.customerName}`, body);
    await sendEmail(
      o.customerEmail,
      '阿男伍叁 — 手套客製訂單確認',
      `${o.customerName} 您好，\n\n已收到您的客製手套訂單，我們將在 2 個工作天內與您聯繫確認報價。\n\n訂單摘要：\n${detail}\n\n— 阿男伍叁 A-Nan 53`
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`A-Nan 53 Builder running on port ${PORT}`));
