require('dotenv').config();

async function notify(message) {
  const token = process.env.LINE_TOKEN;
  const userId = process.env.LINE_USER_ID;
  if (!token || !userId) return;

  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text: message }]
      })
    });
  } catch (e) {
    console.error('LINE 通知失敗:', e.message);
  }
}

module.exports = { notify };
