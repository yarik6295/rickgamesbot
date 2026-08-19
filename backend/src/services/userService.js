const db = require('../db/database');

/**
 * Короткоживущий in-memory кэш пользователя.
 *
 * ПОЧЕМУ: getOrCreateUser раньше на КАЖДЫЙ запрос (в т.ч. на каждый клик
 * по клетке в Mines/Towers и на каждый клик "Забрать" в Crash) делал
 * SELECT к удалённой Turso-базе ДО того, как игра вообще успевала
 * посчитать результат — это был отдельный сетевой round-trip, который
 * целиком уходил в задержку между кликом и ответом. Для Crash это было
 * особенно заметно: мультипликатор в cashout() считается по Date.now()
 * ПОСЛЕ этого запроса, поэтому чем дольше шёл поход в БД, тем выше успевал
 * "убежать" мультипликатор — отсюда и разница вроде "нажал на 2.00, а
 * забрало 2.05".
 *
 * TTL небольшой (несколько секунд) — этого достаточно, чтобы не ходить в
 * БД на каждый клик в рамках одного игрового раунда, но при этом баланс,
 * изменённый где-то ещё (открытие кейса, топ-ап), не "залипал" надолго.
 * Плюс к этому баланс в кэше активно обновляется точечно (см.
 * touchCachedBalance) сразу после каждого списания/начисления в играх —
 * так что в рамках одной игровой сессии кэш всегда актуален, а TTL — это
 * просто подстраховка для путей, которые его явно не трогают.
 */
const CACHE_TTL_MS = 5000;
const userCacheByTelegramId = new Map(); // telegram_id -> { user, cachedAt }
const telegramIdByUserId = new Map();    // id -> telegram_id (для точечных обновлений баланса)

function cacheUser(telegramId, user) {
    userCacheByTelegramId.set(telegramId, { user, cachedAt: Date.now() });
    telegramIdByUserId.set(user.id, telegramId);
}

/**
 * executor — необязательный параметр: либо основной db (по умолчанию),
 * либо tx-объект, переданный изнутри db.transaction(async (tx) => {...}),
 * чтобы чтение/создание пользователя было частью той же транзакции.
 */
async function getOrCreateUser(telegramUser, executor = db) {
    const cached = userCacheByTelegramId.get(telegramUser.id);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        return cached.user;
    }

    const existing = await executor.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegramUser.id]);
    if (existing) {
        cacheUser(telegramUser.id, existing);
        return existing;
    }

    const info = await executor.run(`
        INSERT INTO users (telegram_id, username, first_name, photo_url, coins_balance, account_level, cases_opened)
        VALUES (?, ?, ?, ?, 0, 1, 0)
    `, [telegramUser.id, telegramUser.username || null, telegramUser.first_name || null, telegramUser.photo_url || null]);

    const created = await executor.get(`SELECT * FROM users WHERE id = ?`, [info.lastInsertRowid]);
    // Кэшируем ТОЛЬКО уже существующих пользователей (ветка `existing` выше).
    // Если создание произошло внутри транзакции (executor = tx), а транзакция
    // позже всё же откатится (например, ставка больше нулевого баланса
    // нового юзера), закэшированная здесь строка была бы "фантомной" —
    // ссылалась бы на id, которого в БД так и не появилось. Новый
    // пользователь закэшируется сам на следующем обращении, когда его
    // строка уже точно закоммичена.
    return created;
}

/**
 * Точечно обновляет баланс пользователя в кэше сразу после
 * списания/начисления — чтобы в рамках одной игровой сессии (серия
 * кликов Mines/Towers, cashout в Crash) кэш был всегда актуален и не
 * приходилось ждать истечения TTL.
 */
function touchCachedBalance(userId, newBalance) {
    const telegramId = telegramIdByUserId.get(userId);
    if (telegramId == null) return;
    const cached = userCacheByTelegramId.get(telegramId);
    if (cached) cached.user.coins_balance = newBalance;
}

/**
 * Сбрасывает кэш для пользователя (на случай путей, которые меняют
 * баланс/уровень напрямую и не вызывают touchCachedBalance).
 */
function invalidateUserCache(userId) {
    const telegramId = telegramIdByUserId.get(userId);
    if (telegramId != null) userCacheByTelegramId.delete(telegramId);
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

/**
 * Включает/выключает анонимность в топе игроков (leaderboard_anonymous).
 * По умолчанию у новых пользователей она включена (см. schema.sql).
 */
async function setLeaderboardAnonymous(userId, anonymous, executor = db) {
    await executor.run(`UPDATE users SET leaderboard_anonymous = ? WHERE id = ?`, [anonymous ? 1 : 0, userId]);
    invalidateUserCache(userId);
}

module.exports = {
    getOrCreateUser,
    getUserById,
    computeLevel,
    touchCachedBalance,
    invalidateUserCache,
    setLeaderboardAnonymous,
};
