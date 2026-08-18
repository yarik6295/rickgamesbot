const db = require('../db/database');
const { generateCrashPoint } = require('./gamesService');
const { touchCachedBalance } = require('./userService');

/**
 * Crash — общий "живой" раунд для всех игроков одновременно (см. подробное
 * описание фаз в комментарии выше в оригинальной версии файла).
 *
 * ВАЖНО про переезд на Turso: сам игровой цикл (tick/фазы/таймер) остаётся
 * полностью синхронным и не ждёт сеть — это критично для точности таймингов
 * раунда. Запись в БД (списание ставки, начисление выигрыша, лог раунда)
 * асинхронная, но обёрнута так, чтобы не блокировать и не путать fasedTicks:
 * при крахе раунда состояние (phase='crashed') фиксируется СИНХРОННО первым
 * делом, а запись логов проигравших уходит в фоне (fire-and-forget с
 * логированием ошибки), чтобы следующий tick() не мог провалиться в ту же
 * ветку ещё раз, пока пишутся логи.
 */

const WAITING_MS = 6000;
const CRASHED_MS = 3500;
const TICK_MS = 100;
const GROWTH_K = 0.11;
const HISTORY_LIMIT = 30;

const MIN_BET = 5;
const MAX_BET = 100000;

const state = {
    phase: 'waiting',
    roundId: 1,
    phaseStartedAt: Date.now(),
    flyingStartedAt: null,
    crashPoint: null,
    serverSeed: null,
    history: [],
    players: new Map(),
};

async function ledgerDebit(userId, amount, type, referenceId) {
    const user = await db.get(`SELECT coins_balance FROM users WHERE id = ?`, [userId]);
    const newBalance = user.coins_balance - amount;
    await db.run(`UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [newBalance, userId]);
    await db.run(`INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id) VALUES (?, ?, ?, ?, ?)`,
        [userId, type, -amount, newBalance, referenceId || null]);
    touchCachedBalance(userId, newBalance);
    return newBalance;
}

async function ledgerCredit(userId, amount, type, referenceId) {
    const user = await db.get(`SELECT coins_balance FROM users WHERE id = ?`, [userId]);
    const newBalance = user.coins_balance + amount;
    await db.run(`UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [newBalance, userId]);
    if (amount > 0) {
        await db.run(`INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id) VALUES (?, ?, ?, ?, ?)`,
            [userId, type, amount, newBalance, referenceId || null]);
    }
    touchCachedBalance(userId, newBalance);
    return newBalance;
}

async function logRound(userId, bet, payout, multiplier, outcome, roundData, serverSeed) {
    await db.run(`
        INSERT INTO game_rounds (user_id, game_type, bet_coins, payout_coins, multiplier, outcome, round_data, server_seed)
        VALUES (?, 'crash', ?, ?, ?, ?, ?, ?)
    `, [userId, bet, payout, multiplier, outcome, JSON.stringify(roundData), serverSeed]);
}

function computeMultiplier(now) {
    if (state.phase !== 'flying' || !state.flyingStartedAt) return 1;
    const t = Math.max(0, (now - state.flyingStartedAt) / 1000);
    const mult = Math.exp(GROWTH_K * t);
    return Math.max(1, Math.round(mult * 100) / 100);
}

function startWaiting(now) {
    state.phase = 'waiting';
    state.phaseStartedAt = now;
    state.flyingStartedAt = null;
    state.crashPoint = null;
    state.serverSeed = null;
    state.roundId += 1;
    state.players = new Map();
}

function startFlying(now) {
    const { crashPoint, serverSeed } = generateCrashPoint();
    state.phase = 'flying';
    state.phaseStartedAt = now;
    state.flyingStartedAt = now;
    state.crashPoint = crashPoint;
    state.serverSeed = serverSeed;
}

function crashRound(now) {
    // Список проигравших фиксируем сразу, а сам переход фазы делаем
    // синхронно — следующий tick() уже не попадёт в эту ветку повторно,
    // даже если запись логов в БД ещё не завершилась.
    const losers = [];
    for (const [userId, p] of state.players.entries()) {
        if (!p.cashedOut) losers.push([userId, p]);
    }

    const crashPoint = state.crashPoint;
    const roundId = state.roundId;
    const serverSeed = state.serverSeed;

    state.history.unshift({ point: crashPoint, roundId });
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
    state.phase = 'crashed';
    state.phaseStartedAt = now;

    for (const [userId, p] of losers) {
        logRound(userId, p.bet, 0, crashPoint, 'lose', { crashPoint, roundId }, serverSeed)
            .catch((err) => console.error('[crashEngine] Не удалось записать проигрышный раунд:', err));
    }
}

function tick() {
    const now = Date.now();
    const elapsed = now - state.phaseStartedAt;
    if (state.phase === 'waiting') {
        if (elapsed >= WAITING_MS) startFlying(now);
    } else if (state.phase === 'flying') {
        if (computeMultiplier(now) >= state.crashPoint) crashRound(now);
    } else if (state.phase === 'crashed') {
        if (elapsed >= CRASHED_MS) startWaiting(now);
    }
}

setInterval(tick, TICK_MS);

function validateBet(bet, userBalance) {
    const n = Number(bet);
    if (!Number.isInteger(n) || n < MIN_BET || n > MAX_BET) {
        throw { status: 400, message: `Ставка должна быть от ${MIN_BET} до ${MAX_BET} звёзд` };
    }
    if (n > userBalance) throw { status: 402, message: 'Недостаточно звёзд на балансе' };
    return n;
}

async function placeBet(user, betRaw) {
    if (state.phase !== 'waiting') {
        throw { status: 409, message: 'Приём ставок закрыт — раунд уже идёт, дождитесь следующего' };
    }
    if (state.players.has(user.id)) {
        throw { status: 409, message: 'Вы уже поставили в этом раунде' };
    }
    const bet = validateBet(betRaw, user.coins_balance);
    const newBalance = await ledgerDebit(user.id, bet, 'game_bet');
    state.players.set(user.id, {
        bet,
        cashedOut: false,
        cashoutMultiplier: null,
        payout: 0,
        username: user.username || user.first_name || 'Игрок',
    });
    return { newBalance, roundId: state.roundId };
}

async function cashout(user, requestedAt) {
    // requestedAt — момент, когда HTTP-запрос реально пришёл на сервер
    // (фиксируется в контроллере ДО похода за пользователем в БД, см.
    // gamesController.crashCashout). Раньше мультипликатор здесь считался
    // по Date.now(), взятому уже ПОСЛЕ await getOrCreateUser() — то есть
    // после отдельного сетевого round-trip до Turso. Пока этот запрос
    // летал, мультипликатор в быстро растущей кривой успевал заметно
    // "убежать" вперёд — отсюда и жалоба "нажал на 2.00, а забрало 2.05".
    // Теперь момент клика фиксируется как можно раньше и передаётся сюда
    // готовым, поэтому расчёт больше не ждёт никаких походов в БД.
    const now = requestedAt || Date.now();
    const p = state.players.get(user.id);
    if (!p) throw { status: 404, message: 'Вы не участвуете в текущем раунде' };
    if (p.cashedOut) throw { status: 409, message: 'Вы уже забрали выигрыш в этом раунде' };
    if (state.phase !== 'flying') {
        throw { status: 409, message: 'Раунд ещё не начался или уже завершён' };
    }
    const mult = computeMultiplier(now);
    if (mult >= state.crashPoint) {
        throw { status: 409, message: 'Не успели — раунд лопнул', crashPoint: state.crashPoint };
    }
    p.cashedOut = true;
    p.cashoutMultiplier = mult;
    p.payout = Math.floor(p.bet * mult);
    const newBalance = await ledgerCredit(user.id, p.payout, 'game_win');
    await logRound(user.id, p.bet, p.payout, mult, 'cashout', { crashPoint: null, roundId: state.roundId }, state.serverSeed);
    return { multiplier: mult, payout: p.payout, newBalance };
}

function getPublicState(userId) {
    const now = Date.now();
    const base = {
        phase: state.phase,
        roundId: state.roundId,
        playersCount: state.players.size,
        history: state.history.map((h) => h.point),
        waitingMs: WAITING_MS,
    };
    if (state.phase === 'waiting') {
        base.msLeft = Math.max(0, WAITING_MS - (now - state.phaseStartedAt));
    } else if (state.phase === 'flying') {
        base.multiplier = computeMultiplier(now);
        base.flyingStartedAt = state.flyingStartedAt;
        base.growthK = GROWTH_K;
    } else if (state.phase === 'crashed') {
        base.crashPoint = state.crashPoint;
        base.msLeft = Math.max(0, CRASHED_MS - (now - state.phaseStartedAt));
    }
    const mine = userId != null ? state.players.get(userId) : null;
    base.myBet = mine
        ? { bet: mine.bet, cashedOut: mine.cashedOut, cashoutMultiplier: mine.cashoutMultiplier, payout: mine.payout }
        : null;
    return base;
}

module.exports = { getPublicState, placeBet, cashout };
