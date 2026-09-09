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

/**
 * БАГ-ФИКС (гонка в minesReveal/towersPick): контроллер узнаёт id
 * пользователя только ПОСЛЕ `await getOrCreateUser(...)`, а до этого
 * момента синхронно залочить сессию по userId нельзя. Если между стартом
 * этого await и его завершением приходил второй почти параллельный
 * запрос (двойной тап, повтор из-за таймаута), оба успевали пройти
 * проверку "клетка ещё не открыта" и оба пушили в session.revealed —
 * то есть за одно "нажатие" открывались 2 клетки с более высоким
 * мультипликатором, чем допускает выбранный риск.
 *
 * Лочим не по userId (он ещё не известен), а по telegramUser.id — он
 * доступен из req СИНХРОННО, до первого await. Set.has/add — синхронные
 * операции, поэтому check-and-set здесь атомарен даже при интерливинге
 * промисов в event loop: вторая параллельная попытка гарантированно
 * увидит уже занятый лок.
 */
const locks = new Set();

function tryLock(lockKey) {
    if (locks.has(lockKey)) return false;
    locks.add(lockKey);
    return true;
}

function unlock(lockKey) {
    locks.delete(lockKey);
}

module.exports = { get, set, remove, tryLock, unlock };
