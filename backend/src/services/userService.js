const db = require('../db/database');

/**
 * executor — необязательный параметр: либо основной db (по умолчанию),
 * либо tx-объект, переданный изнутри db.transaction(async (tx) => {...}),
 * чтобы чтение/создание пользователя было частью той же транзакции.
 */
async function getOrCreateUser(telegramUser, executor = db) {
    const existing = await executor.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegramUser.id]);
    if (existing) return existing;

    const info = await executor.run(`
        INSERT INTO users (telegram_id, username, first_name, photo_url, coins_balance, account_level, cases_opened)
        VALUES (?, ?, ?, ?, 0, 1, 0)
    `, [telegramUser.id, telegramUser.username || null, telegramUser.first_name || null, telegramUser.photo_url || null]);

    return executor.get(`SELECT * FROM users WHERE id = ?`, [info.lastInsertRowid]);
}

async function getUserById(id, executor = db) {
    return executor.get(`SELECT * FROM users WHERE id = ?`, [id]);
}

/**
 * Уровень аккаунта — чисто косметический прогресс (влияет на доступ к кейсам
 * и на размер ежедневного бонуса), НЕ на возможность вывода чего-либо реального.
 */
function computeLevel(casesOpened) {
    if (casesOpened >= 100) return 5;
    if (casesOpened >= 50) return 4;
    if (casesOpened >= 20) return 3;
    if (casesOpened >= 5) return 2;
    return 1;
}

module.exports = {
    getOrCreateUser,
    getUserById,
    computeLevel,
};
