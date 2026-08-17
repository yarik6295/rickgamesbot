const db = require('../db/database');
const { generateCrashPoint } = require('./gamesService');

/**
 * Crash — общий "живой" раунд для всех игроков одновременно, как в реальных
 * казино-crash играх (Aviator/JetX и т.п.), а не отдельный раунд на юзера.
 *
 * Один процесс = один вечный цикл фаз, крутится с момента старта сервера:
 *
 *   waiting (WAITING_MS)  — приём ставок, обратный отсчёт до старта
 *     → flying             — мультипликатор растёт по формуле mult(t)=e^(k·t)
 *       → crashed (CRASHED_MS) — показываем точку краша всем, кто не успел
 *         → waiting (новый раунд)
 *
 * Всё состояние (crashPoint, кто на какую сумму поставил, кто уже забрал) —
 * только в памяти сервера, клиенты только читают его через /crash/state и
 * шлют намерения (bet/cashout). Раунд один и тот же для всех — кто угодно,
 * подключившийся в любой момент, видит одну и ту же фазу/мультипликатор.
 */

const WAITING_MS = 6000;   // приём ставок перед стартом
const CRASHED_MS = 3500;   // показ результата после краша
const TICK_MS = 100;
const GROWTH_K = 0.11;     // скорость роста: mult = e^(GROWTH_K * секунды)
const HISTORY_LIMIT = 30;

const MIN_BET = 5;
const MAX_BET = 100000;

const state = {
    phase: 'waiting',       // 'waiting' | 'flying' | 'crashed'
    roundId: 1,
    phaseStartedAt: Date.now(),
    flyingStartedAt: null,
    crashPoint: null,
    serverSeed: null,
    history: [],             // [{ point, roundId }], новые — в начале
    players: new Map(),      // userId -> { bet, cashedOut, cashoutMultiplier, payout, username }
};

function ledgerDebit(userId, amount, type, referenceId) {
    const user = db.prepare(`SELECT coins_balance FROM users WHERE id = ?`).get(userId);
    const newBalance = user.coins_balance - amount;
    db.prepare(`UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newBalance, userId);
    db.prepare(`INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id) VALUES (?, ?, ?, ?, ?)`)
        .run(userId, type, -amount, newBalance, referenceId || null);
    return newBalance;
}

function ledgerCredit(userId, amount, type, referenceId) {
    const user = db.prepare(`SELECT coins_balance FROM users WHERE id = ?`).get(userId);
    const newBalance = user.coins_balance + amount;
    db.prepare(`UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newBalance, userId);
    if (amount > 0) {
        db.prepare(`INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id) VALUES (?, ?, ?, ?, ?)`)
            .run(userId, type, amount, newBalance, referenceId || null);
    }
    return newBalance;
}

function logRound(userId, bet, payout, multiplier, outcome, roundData, serverSeed) {
    db.prepare(`
        INSERT INTO game_rounds (user_id, game_type, bet_coins, payout_coins, multiplier, outcome, round_data, server_seed)
        VALUES (?, 'crash', ?, ?, ?, ?, ?, ?)
    `).run(userId, bet, payout, multiplier, outcome, JSON.stringify(roundData), serverSeed);
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
    // Все, кто не успел забрать до краша, проигрывают ставку (она уже
    // списана в момент bet — см. placeBet).
    for (const [userId, p] of state.players.entries()) {
        if (!p.cashedOut) {
            logRound(userId, p.bet, 0, state.crashPoint, 'lose', { crashPoint: state.crashPoint, roundId: state.roundId }, state.serverSeed);
        }
    }
    state.history.unshift({ point: state.crashPoint, roundId: state.roundId });
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
    state.phase = 'crashed';
    state.phaseStartedAt = now;
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

// Цикл запускается один раз при загрузке модуля и живёт весь процесс —
// раунд действительно один общий и непрерывный для всех подключений.
setInterval(tick, TICK_MS);

function validateBet(bet, userBalance) {
    const n = Number(bet);
    if (!Number.isInteger(n) || n < MIN_BET || n > MAX_BET) {
        throw { status: 400, message: `Ставка должна быть от ${MIN_BET} до ${MAX_BET} звёзд` };
    }
    if (n > userBalance) throw { status: 402, message: 'Недостаточно звёзд на балансе' };
    return n;
}

function placeBet(user, betRaw) {
    if (state.phase !== 'waiting') {
        throw { status: 409, message: 'Приём ставок закрыт — раунд уже идёт, дождитесь следующего' };
    }
    if (state.players.has(user.id)) {
        throw { status: 409, message: 'Вы уже поставили в этом раунде' };
    }
    const bet = validateBet(betRaw, user.coins_balance);
    const newBalance = ledgerDebit(user.id, bet, 'game_bet');
    state.players.set(user.id, {
        bet,
        cashedOut: false,
        cashoutMultiplier: null,
        payout: 0,
        username: user.username || user.first_name || 'Игрок',
    });
    return { newBalance, roundId: state.roundId };
}

function cashout(user) {
    const p = state.players.get(user.id);
    if (!p) throw { status: 404, message: 'Вы не участвуете в текущем раунде' };
    if (p.cashedOut) throw { status: 409, message: 'Вы уже забрали выигрыш в этом раунде' };
    if (state.phase !== 'flying') {
        throw { status: 409, message: 'Раунд ещё не начался или уже завершён' };
    }
    const mult = computeMultiplier(Date.now());
    if (mult >= state.crashPoint) {
        throw { status: 409, message: 'Не успели — раунд лопнул', crashPoint: state.crashPoint };
    }
    p.cashedOut = true;
    p.cashoutMultiplier = mult;
    p.payout = Math.floor(p.bet * mult);
    const newBalance = ledgerCredit(user.id, p.payout, 'game_win');
    logRound(user.id, p.bet, p.payout, mult, 'cashout', { crashPoint: null, roundId: state.roundId }, state.serverSeed);
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
