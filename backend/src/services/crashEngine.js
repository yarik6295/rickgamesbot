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

// См. подробный комментарий у debit()/credit() в gamesController.js — та
// же самая уязвимость (SELECT-затем-UPDATE давал окно для потерянного
// обновления при параллельных запросах) и то же исправление: одно
// атомарное UPDATE...RETURNING вместо чтения-затем-записи, с проверкой
// достаточности баланса прямо в WHERE.
async function ledgerDebit(userId, amount, type, referenceId) {
    const updated = await db.get(`
        UPDATE users SET coins_balance = coins_balance - ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND coins_balance >= ?
        RETURNING coins_balance
    `, [amount, userId, amount]);

    if (!updated) {
        throw { status: 402, message: 'Недостаточно звёзд на балансе' };
    }

    const newBalance = updated.coins_balance;
    touchCachedBalance(userId, newBalance);
    db.run(`INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id) VALUES (?, ?, ?, ?, ?)`,
        [userId, type, -amount, newBalance, referenceId || null])
        .catch((err) => console.error('[crashEngine] Не удалось записать транзакцию списания:', err));
    return newBalance;
}

async function ledgerCredit(userId, amount, type, referenceId) {
    const updated = await db.get(`
        UPDATE users SET coins_balance = coins_balance + ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        RETURNING coins_balance
    `, [amount, userId]);

    const newBalance = updated.coins_balance;
    touchCachedBalance(userId, newBalance);
    if (amount > 0) {
        db.run(`INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id) VALUES (?, ?, ?, ?, ?)`,
            [userId, type, amount, newBalance, referenceId || null])
            .catch((err) => console.error('[crashEngine] Не удалось записать транзакцию начисления:', err));
    }
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

    // Бронируем место в раунде СИНХРОННО, до await ledgerDebit() — без
    // этого два почти одновременных запроса на ставку от одного игрока
    // (двойной клик, гонка сети и т.п.) оба проходили бы проверку
    // "players.has(user.id)" выше (в обоих ещё false) и оба успевали бы
    // списать баланс, прежде чем кто-то из них попадёт в state.players —
    // то есть можно было списать ставку дважды, а зарегистрироваться в
    // раунде только один раз.
    state.players.set(user.id, {
        bet,
        cashedOut: false,
        cashoutMultiplier: null,
        payout: 0,
        username: user.username || user.first_name || 'Игрок',
    });

    try {
        const newBalance = await ledgerDebit(user.id, bet, 'game_bet');
        return { newBalance, roundId: state.roundId };
    } catch (err) {
        // Списание не удалось (баланса реально не хватило, хоть проверка
        // по кэшу выше это и пропустила) — откатываем бронь места.
        state.players.delete(user.id);
        throw err;
    }
}

async function cashout(user, requestedAt, requestedMultiplier) {
    // requestedAt — момент, когда HTTP-запрос реально пришёл на сервер
    // (фиксируется в контроллере ДО похода за пользователем в БД, см.
    // gamesController.crashCashout).
    //
    // requestedMultiplier — значение мультипликатора, которое игрок реально
    // ВИДЕЛ на экране в момент клика "Забрать"/срабатывания автовывода
    // (клиент считает его сам локально по той же формуле, см. loop() в
    // games.js). Раньше сервер игнорировал это значение и всегда платил по
    // мультипликатору на момент, когда запрос ДОШЁЛ до сервера — а это
    // время сетевой передачи (клиент → сервер), которое принципиально
    // нельзя свести к нулю. Поэтому даже после устранения задержек в самом
    // бэкенде (поход в БД до расчёта, см. requestedAt выше) видимый разрыв
    // "нажал на 2.00, а забрало 2.05" мог оставаться — это уже не баг
    // бэкенда, а просто пинг до сервера, за который кривая успевает
    // подрасти. Поскольку валюта полностью виртуальная (не выводится и не
    // покупается), решаем это честно и в пользу игрока: платим ИМЕННО ПО
    // ТОМУ значению, которое игрок видел на экране, а не по более
    // позднему (и обычно более высокому) серверному значению — при этом
    // не доверяем клиенту "вслепую": ниже проверяем, что запрошенное
    // значение вообще математически МОГЛО уже наступить к этому моменту
    // (не выше того, что сервер сам насчитал на now) и не выше точки
    // краша — так что накрутить себе более высокий кэшаут через этот
    // параметр невозможно.
    const now = requestedAt || Date.now();
    const p = state.players.get(user.id);
    if (!p) throw { status: 404, message: 'Вы не участвуете в текущем раунде' };
    if (p.cashedOut) throw { status: 409, message: 'Вы уже забрали выигрыш в этом раунде' };
    if (state.phase !== 'flying') {
        throw { status: 409, message: 'Раунд ещё не начался или уже завершён' };
    }
    const serverMult = computeMultiplier(now);
    if (serverMult >= state.crashPoint) {
        throw { status: 409, message: 'Не успели — раунд лопнул', crashPoint: state.crashPoint };
    }

    const requested = Number(requestedMultiplier);
    let mult = serverMult;
    if (Number.isFinite(requested) && requested >= 1) {
        // Честная планка сверху: то, что игрок "видел", не может быть выше
        // того, что сервер сам насчитал бы на момент прихода запроса (иначе
        // это было бы значение из будущего) и не выше точки краша.
        mult = Math.min(requested, serverMult, state.crashPoint - 0.01);
        mult = Math.max(1, Math.round(mult * 100) / 100);
    }
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
