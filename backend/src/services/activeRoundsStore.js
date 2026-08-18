/**
 * In-memory хранилище активных раундов Mines/Towers.
 *
 * ПОЧЕМУ: раньше каждый клик по клетке (mines/reveal, towers/pick) делал
 * несколько ПОСЛЕДОВАТЕЛЬНЫХ запросов к удалённой Turso-базе (получить
 * пользователя, получить строку active_rounds, записать обновлённый
 * revealed) — каждый такой запрос это отдельный сетевой round-trip до
 * Turso, и именно их сумма ощущалась как "задержка между кликом и
 * результатом".
 *
 * РЕШЕНИЕ: скрытое состояние активного раунда (мины/бомбы, что уже
 * открыто) держим в памяти процесса, как и общий раунд Crash в
 * crashEngine.js. Ответ на клик формируется мгновенно из памяти, без
 * ожидания сети. В Turso состояние всё равно пишется — но в фоне
 * (fire-and-forget), только чтобы раунд восстанавливался после
 * перезагрузки страницы (см. .../status). Если сам процесс сервера
 * перезапустится ровно в этот момент — активный раунд теряется, это то
 * же самое ограничение, которое уже принято для Crash (см. комментарий
 * в начале crashEngine.js).
 */

const store = new Map(); // ключ: `${userId}:${gameType}` -> объект сессии

function key(userId, gameType) {
    return `${userId}:${gameType}`;
}

function get(userId, gameType) {
    return store.get(key(userId, gameType));
}

function set(userId, gameType, session) {
    store.set(key(userId, gameType), session);
    return session;
}

function remove(userId, gameType) {
    store.delete(key(userId, gameType));
}

module.exports = { get, set, remove };
