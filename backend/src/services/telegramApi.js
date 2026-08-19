require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;

function botApiUrl(method) {
    if (!BOT_TOKEN) throw new Error('BOT_TOKEN не задан');
    return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

/**
 * Тонкая обёртка над Telegram Bot API (Node 18+ имеет глобальный fetch).
 * Бросает Error с текстом описания Telegram, если ok !== true.
 */
async function callBotApi(method, body) {
    const response = await fetch(botApiUrl(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(data.description || `Telegram Bot API error (${response.status})`);
    }
    return data.result;
}

module.exports = { callBotApi, BOT_TOKEN };
