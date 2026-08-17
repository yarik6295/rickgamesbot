const db = require('../db/database');

function getOrCreateUser(telegramUser) {
    const existing = db.prepare(`SELECT * FROM users WHERE telegram_id = ?`).get(telegramUser.id);
    if (existing) return existing;

    const info = db.prepare(`
        INSERT INTO users (telegram_id, username, first_name, photo_url, coins_balance, account_level, cases_opened)
        VALUES (?, ?, ?, ?, 500, 1, 0)
    `).run(telegramUser.id, telegramUser.username || null, telegramUser.first_name || null, telegramUser.photo_url || null);

    return db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
}

function getUserById(id) {
    return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
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
