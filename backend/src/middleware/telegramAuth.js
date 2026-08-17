const crypto = require('crypto');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const DEV_SKIP = process.env.DEV_SKIP_TELEGRAM_AUTH === 'true';
// Плейсхолдер из .env.example — если его забыли заменить на реальный токен,
// подпись НИКОГДА не совпадёт и все запросы будут падать с 403.
const PLACEHOLDER_TOKEN = '123456789:AAExampleTelegramBotTokenHere';
const MAX_INIT_DATA_AGE_MS = Number(process.env.INIT_DATA_MAX_AGE_SEC || 86400) * 1000;

/**
 * Валидирует Telegram WebApp initData согласно официальной документации:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Клиент присылает заголовок X-Telegram-Init-Data (строка, полученная из
 * window.Telegram.WebApp.initData на фронтенде).
 *
 * Возвращает { user } при успехе или { error } с кодом причины при провале —
 * так в логах и в ответе видно, что именно не сошлось, а не общее "невалидно".
 */
function verifyInitData(initData, botToken) {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    if (!hash) return { error: 'missing_hash' };
    urlParams.delete('hash');

    const dataCheckArr = [];
    for (const [key, value] of [...urlParams.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        dataCheckArr.push(`${key}=${value}`);
    }
    const dataCheckString = dataCheckArr.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) return { error: 'bad_signature' };

    // Проверка свежести auth_date (по умолчанию не старше 24 часов, настраивается
    // через INIT_DATA_MAX_AGE_SEC)
    const authDate = Number(urlParams.get('auth_date')) * 1000;
    const isFresh = Date.now() - authDate < MAX_INIT_DATA_AGE_MS;
    if (!isFresh) return { error: 'expired' };

    const userJson = urlParams.get('user');
    if (!userJson) return { error: 'missing_user' };

    return { user: JSON.parse(userJson) };
}

function telegramAuthMiddleware(req, res, next) {
    if (DEV_SKIP) {
        // Только для локальной разработки вне Telegram!
        req.telegramUser = req.headers['x-dev-telegram-id']
            ? { id: Number(req.headers['x-dev-telegram-id']), first_name: 'DevUser', username: 'dev_user' }
            : { id: 1000001, first_name: 'DevUser', username: 'dev_user' };
        return next();
    }

    const initData = req.headers['x-telegram-init-data'];
    if (!initData) {
        return res.status(401).json({ error: 'Отсутствует X-Telegram-Init-Data' });
    }
    if (!BOT_TOKEN || BOT_TOKEN === PLACEHOLDER_TOKEN) {
        console.error('[telegramAuth] BOT_TOKEN не задан или оставлен как плейсхолдер из .env.example — вставьте реальный токен от @BotFather');
        return res.status(500).json({ error: 'BOT_TOKEN не сконфигурирован на сервере' });
    }

    const { user, error } = verifyInitData(initData, BOT_TOKEN);
    if (!user) {
        console.warn(`[telegramAuth] initData отклонена: ${error}`);
        return res.status(403).json({ error: 'Невалидная или устаревшая initData', reason: error });
    }

    req.telegramUser = user;
    next();
}

module.exports = telegramAuthMiddleware;
