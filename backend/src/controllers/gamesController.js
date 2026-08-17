const db = require('../db/database');
const { getOrCreateUser } = require('../services/userService');
const crashEngine = require('../services/crashEngine');
const {
    generateMinePositions,
    minesMultiplier,
    playPlinko,
    generateTowerLayout,
    towersMultiplierPerRow,
    UPGRADE_MIN_CHANCE,
    UPGRADE_MAX_CHANCE,
    upgradeMultiplier,
    playUpgrade,
    WHEEL_SEGMENTS,
    playWheel,
} = require('../services/gamesService');
const crypto = require('crypto');

const MIN_BET = 5;
const MAX_BET = 100000;

function validateBet(bet, userBalance) {
    const n = Number(bet);
    if (!Number.isInteger(n) || n < MIN_BET || n > MAX_BET) {
        throw { status: 400, message: `Ставка должна быть от ${MIN_BET} до ${MAX_BET} звёзд` };
    }
    if (n > userBalance) throw { status: 402, message: 'Недостаточно звёзд на балансе' };
    return n;
}

function debit(userId, amount, type, referenceId = null) {
    const user = db.prepare(`SELECT coins_balance FROM users WHERE id = ?`).get(userId);
    const newBalance = user.coins_balance - amount;
    db.prepare(`UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newBalance, userId);
    db.prepare(`INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id) VALUES (?, ?, ?, ?, ?)`)
        .run(userId, type, -amount, newBalance, referenceId);
    return newBalance;
}

function credit(userId, amount, type, referenceId = null) {
    const user = db.prepare(`SELECT coins_balance FROM users WHERE id = ?`).get(userId);
    const newBalance = user.coins_balance + amount;
    db.prepare(`UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newBalance, userId);
    if (amount > 0) {
        db.prepare(`INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id) VALUES (?, ?, ?, ?, ?)`)
            .run(userId, type, amount, newBalance, referenceId);
    }
    return newBalance;
}

function logRound(userId, gameType, bet, payout, multiplier, outcome, roundData, serverSeed) {
    db.prepare(`
        INSERT INTO game_rounds (user_id, game_type, bet_coins, payout_coins, multiplier, outcome, round_data, server_seed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, gameType, bet, payout, multiplier, outcome, JSON.stringify(roundData), serverSeed);
}

/* ================================ CRASH ================================ */
// Раунд общий и непрерывный для всех игроков (см. services/crashEngine.js) —
// контроллер тут только мост между HTTP и движком.

function crashState(req, res) {
    const user = getOrCreateUser(req.telegramUser);
    res.json(crashEngine.getPublicState(user.id));
}

function crashBet(req, res) {
    try {
        const user = getOrCreateUser(req.telegramUser);
        const result = crashEngine.placeBet(user, req.body.bet);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка ставки' });
    }
}

function crashCashout(req, res) {
    try {
        const user = getOrCreateUser(req.telegramUser);
        const result = crashEngine.cashout(user);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка вывода', crashPoint: err.crashPoint });
    }
}

/* ================================ MINES ================================ */
function minesStart(req, res) {
    try {
        // БАГ (исправлено): списание ставки (debit) и создание active_rounds
        // раньше не были одной транзакцией — в отличие от openCase/plinkoPlay/
        // upgradePlay, где это уже было обёрнуто в db.transaction. Если между
        // этими двумя запросами что-то падало (например, INSERT нарушал
        // UNIQUE(user_id, game_type), если гонка двух почти одновременных
        // стартов проскакивала мимо проверки existing выше), звёзды уже
        // списывались, а активный раунд не создавался — деньги пропадали
        // без следа и без возможности откатить.
        const startTx = db.transaction(() => {
            const user = getOrCreateUser(req.telegramUser);
            const existing = db.prepare(`SELECT id FROM active_rounds WHERE user_id = ? AND game_type = 'mines'`).get(user.id);
            if (existing) throw { status: 409, message: 'У вас уже есть активный раунд Mines' };

            const bet = validateBet(req.body.bet, user.coins_balance);
            const gridSize = 25;
            const mineCount = Math.min(Math.max(Number(req.body.mineCount) || 3, 1), 24);

            const mines = generateMinePositions(gridSize, mineCount);
            const serverSeed = crypto.randomBytes(16).toString('hex');

            const newBalance = debit(user.id, bet, 'game_bet');

            db.prepare(`
                INSERT INTO active_rounds (user_id, game_type, bet_coins, config, hidden_state, revealed, server_seed)
                VALUES (?, 'mines', ?, ?, ?, '[]', ?)
            `).run(user.id, bet, JSON.stringify({ gridSize, mineCount }), JSON.stringify({ mines }), serverSeed);

            return { newBalance, gridSize, mineCount };
        });

        res.json({ success: true, ...startTx() });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка запуска раунда' });
    }
}

function minesReveal(req, res) {
    try {
        const user = getOrCreateUser(req.telegramUser);
        const round = db.prepare(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'mines'`).get(user.id);
        if (!round) throw { status: 404, message: 'Нет активного раунда Mines' };

        const config = JSON.parse(round.config);
        const hidden = JSON.parse(round.hidden_state);
        const revealed = JSON.parse(round.revealed);

        const tile = Number(req.body.tile);
        if (!Number.isInteger(tile) || tile < 0 || tile >= config.gridSize) {
            throw { status: 400, message: 'Некорректная клетка' };
        }
        if (revealed.includes(tile)) throw { status: 400, message: 'Клетка уже открыта' };

        if (hidden.mines.includes(tile)) {
            // Взрыв — раунд проигран, показываем все мины
            db.prepare(`DELETE FROM active_rounds WHERE id = ?`).run(round.id);
            logRound(user.id, 'mines', round.bet_coins, 0, 0, 'lose', { ...config, mines: hidden.mines, revealed }, round.server_seed);
            return res.json({ success: true, hit: true, mines: hidden.mines, newBalance: getOrCreateUser(req.telegramUser).coins_balance });
        }

        revealed.push(tile);
        db.prepare(`UPDATE active_rounds SET revealed = ? WHERE id = ?`).run(JSON.stringify(revealed), round.id);

        const multiplier = minesMultiplier(config.gridSize, config.mineCount, revealed.length);
        const potentialPayout = Math.floor(round.bet_coins * multiplier);

        res.json({ success: true, hit: false, revealed, multiplier, potentialPayout });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка открытия клетки' });
    }
}

// БАГ (исправлено): если пользователь уходил с экрана Mines с активным
// раундом (свернул мини-апп, перезагрузил страницу, переключился на
// другую игру) — раунд оставался живым на сервере (active_rounds), но
// фронтенд после возврата просто рисовал пустой экран "Начать раунд".
// Клик по "Начать раунд" в этом случае падал с 409 "У вас уже есть
// активный раунд Mines", а обычным способом попасть в уже идущий раунд
// пользователь не мог. Этот статус-эндпоинт позволяет фронту при входе
// на экран сначала спросить, есть ли активный раунд, и восстановить UI.
function minesStatus(req, res) {
    const user = getOrCreateUser(req.telegramUser);
    const round = db.prepare(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'mines'`).get(user.id);
    if (!round) return res.json({ active: false });

    const config = JSON.parse(round.config);
    const revealed = JSON.parse(round.revealed);
    const multiplier = revealed.length > 0 ? minesMultiplier(config.gridSize, config.mineCount, revealed.length) : 1;
    const potentialPayout = revealed.length > 0 ? Math.floor(round.bet_coins * multiplier) : 0;

    res.json({
        active: true,
        gridSize: config.gridSize,
        mineCount: config.mineCount,
        bet: round.bet_coins,
        revealed,
        multiplier,
        potentialPayout,
    });
}

function minesCashout(req, res) {
    try {
        const user = getOrCreateUser(req.telegramUser);
        const round = db.prepare(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'mines'`).get(user.id);
        if (!round) throw { status: 404, message: 'Нет активного раунда Mines' };

        const config = JSON.parse(round.config);
        const hidden = JSON.parse(round.hidden_state);
        const revealed = JSON.parse(round.revealed);
        if (revealed.length === 0) throw { status: 400, message: 'Откройте хотя бы одну клетку перед выводом' };

        const multiplier = minesMultiplier(config.gridSize, config.mineCount, revealed.length);
        const payout = Math.floor(round.bet_coins * multiplier);

        db.prepare(`DELETE FROM active_rounds WHERE id = ?`).run(round.id);
        const newBalance = credit(user.id, payout, 'game_win');
        logRound(user.id, 'mines', round.bet_coins, payout, multiplier, 'cashout', { ...config, mines: hidden.mines, revealed }, round.server_seed);

        // Раунд уже закончен — можно безопасно показать, где были все мины
        // (как это делают референсные mines-игры после успешного вывода).
        res.json({ success: true, payout, multiplier, newBalance, mines: hidden.mines });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка вывода' });
    }
}

/* ================================ PLINKO ================================ */
function plinkoPlay(req, res) {
    try {
        // Списание и начисление объединены в транзакцию (как в Upgrade) —
        // если что-то на середине упадёт, баланс не останется в
        // промежуточном (списано, но не начислено) состоянии.
        const tx = db.transaction(() => {
            const user = getOrCreateUser(req.telegramUser);
            const bet = validateBet(req.body.bet, user.coins_balance);
            const risk = ['low', 'medium', 'high'].includes(req.body.risk) ? req.body.risk : 'medium';

            const { path, bucketIndex, multiplier } = playPlinko(risk);
            const payout = Math.floor(bet * multiplier);
            const serverSeed = crypto.randomBytes(16).toString('hex');

            debit(user.id, bet, 'game_bet');
            const newBalance = credit(user.id, payout, 'game_win');
            logRound(user.id, 'plinko', bet, payout, multiplier, payout > bet ? 'win' : 'lose', { risk, path, bucketIndex }, serverSeed);

            return { path, bucketIndex, multiplier, payout, newBalance };
        });

        res.json({ success: true, ...tx() });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка игры' });
    }
}

/* ================================ TOWERS ================================ */
const TOWERS_ROWS = 8;
const TOWERS_TILES_PER_ROW = 3;
const TOWERS_BOMBS_PER_ROW = 1;

function towersStart(req, res) {
    try {
        // См. тот же фикс и комментарий в minesStart выше — debit и INSERT
        // теперь одной транзакцией, чтобы списание ставки без создания
        // раунда было в принципе невозможно.
        const startTx = db.transaction(() => {
            const user = getOrCreateUser(req.telegramUser);
            const existing = db.prepare(`SELECT id FROM active_rounds WHERE user_id = ? AND game_type = 'towers'`).get(user.id);
            if (existing) throw { status: 409, message: 'У вас уже есть активный раунд Towers' };

            const bet = validateBet(req.body.bet, user.coins_balance);
            const layout = generateTowerLayout(TOWERS_ROWS, TOWERS_TILES_PER_ROW, TOWERS_BOMBS_PER_ROW);
            const serverSeed = crypto.randomBytes(16).toString('hex');

            const newBalance = debit(user.id, bet, 'game_bet');

            db.prepare(`
                INSERT INTO active_rounds (user_id, game_type, bet_coins, config, hidden_state, revealed, server_seed)
                VALUES (?, 'towers', ?, ?, ?, '[]', ?)
            `).run(user.id, bet, JSON.stringify({ rows: TOWERS_ROWS, tilesPerRow: TOWERS_TILES_PER_ROW, bombsPerRow: TOWERS_BOMBS_PER_ROW }),
                JSON.stringify({ layout }), serverSeed);

            return { newBalance, rows: TOWERS_ROWS, tilesPerRow: TOWERS_TILES_PER_ROW };
        });

        res.json({ success: true, ...startTx() });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка запуска раунда' });
    }
}

function towersPick(req, res) {
    try {
        const user = getOrCreateUser(req.telegramUser);
        const round = db.prepare(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'towers'`).get(user.id);
        if (!round) throw { status: 404, message: 'Нет активного раунда Towers' };

        const config = JSON.parse(round.config);
        const hidden = JSON.parse(round.hidden_state);
        const revealed = JSON.parse(round.revealed); // массив выбранных индексов по рядам

        const currentRow = revealed.length;
        if (currentRow >= config.rows) throw { status: 400, message: 'Башня уже пройдена целиком' };

        const tile = Number(req.body.tile);
        if (!Number.isInteger(tile) || tile < 0 || tile >= config.tilesPerRow) {
            throw { status: 400, message: 'Некорректная клетка' };
        }

        const rowMultiplier = towersMultiplierPerRow(config.tilesPerRow, config.bombsPerRow);

        if (hidden.layout[currentRow].includes(tile)) {
            db.prepare(`DELETE FROM active_rounds WHERE id = ?`).run(round.id);
            logRound(user.id, 'towers', round.bet_coins, 0, 0, 'lose', { ...config, layout: hidden.layout, revealed }, round.server_seed);
            return res.json({ success: true, hit: true, layout: hidden.layout, newBalance: getOrCreateUser(req.telegramUser).coins_balance });
        }

        revealed.push(tile);
        db.prepare(`UPDATE active_rounds SET revealed = ? WHERE id = ?`).run(JSON.stringify(revealed), round.id);

        // Позиции мин по уже пройденным рядам — можно безопасно раскрыть
        // (эти ряды больше не сыграют роли), чтобы игрок видел, где была
        // мина в ряду, который он прошёл. Позиции будущих рядов не отдаём.
        const bombPositions = hidden.layout.slice(0, revealed.length).map((row) => row[0]);

        const multiplier = Math.round(Math.pow(rowMultiplier, revealed.length) * 100) / 100;
        const potentialPayout = Math.floor(round.bet_coins * multiplier);
        const completed = revealed.length >= config.rows;

        if (completed) {
            db.prepare(`DELETE FROM active_rounds WHERE id = ?`).run(round.id);
            const newBalance = credit(user.id, potentialPayout, 'game_win');
            logRound(user.id, 'towers', round.bet_coins, potentialPayout, multiplier, 'win', { ...config, revealed }, round.server_seed);
            return res.json({ success: true, hit: false, completed: true, revealed, bombPositions, multiplier, payout: potentialPayout, newBalance });
        }

        res.json({ success: true, hit: false, completed: false, revealed, bombPositions, multiplier, potentialPayout });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка хода' });
    }
}

// Тот же фикс восстановления состояния, что и в minesStatus — см. комментарий там.
function towersStatus(req, res) {
    const user = getOrCreateUser(req.telegramUser);
    const round = db.prepare(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'towers'`).get(user.id);
    if (!round) return res.json({ active: false });

    const config = JSON.parse(round.config);
    const hidden = JSON.parse(round.hidden_state);
    const revealed = JSON.parse(round.revealed);
    const bombPositions = hidden.layout.slice(0, revealed.length).map((row) => row[0]);
    const rowMultiplier = towersMultiplierPerRow(config.tilesPerRow, config.bombsPerRow);
    const multiplier = revealed.length > 0 ? Math.round(Math.pow(rowMultiplier, revealed.length) * 100) / 100 : 1;
    const potentialPayout = revealed.length > 0 ? Math.floor(round.bet_coins * multiplier) : 0;

    res.json({
        active: true,
        rows: config.rows,
        tilesPerRow: config.tilesPerRow,
        bet: round.bet_coins,
        currentRow: revealed.length,
        revealed,
        bombPositions,
        multiplier,
        potentialPayout,
    });
}

function towersCashout(req, res) {
    try {
        const user = getOrCreateUser(req.telegramUser);
        const round = db.prepare(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'towers'`).get(user.id);
        if (!round) throw { status: 404, message: 'Нет активного раунда Towers' };

        const config = JSON.parse(round.config);
        const revealed = JSON.parse(round.revealed);
        if (revealed.length === 0) throw { status: 400, message: 'Пройдите хотя бы один этаж перед выводом' };

        const rowMultiplier = towersMultiplierPerRow(config.tilesPerRow, config.bombsPerRow);
        const multiplier = Math.round(Math.pow(rowMultiplier, revealed.length) * 100) / 100;
        const payout = Math.floor(round.bet_coins * multiplier);

        db.prepare(`DELETE FROM active_rounds WHERE id = ?`).run(round.id);
        const newBalance = credit(user.id, payout, 'game_win');
        logRound(user.id, 'towers', round.bet_coins, payout, multiplier, 'cashout', { ...config, revealed }, round.server_seed);

        res.json({ success: true, payout, multiplier, newBalance });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка вывода' });
    }
}

/* ================================ UPGRADE ================================ */
// "Апгрейдер" в стиле CS:GO-кейс-сайтов: ставишь звёзды, выбираешь свой шанс
// выигрыша, крутишь — при выигрыше звёзды умножаются, при проигрыше ставка
// сгорает. Только ставки звёздами — режима ставки предметом больше нет.

function upgradePlay(req, res) {
    try {
        const chance = Number(req.body.chance);
        if (!Number.isInteger(chance) || chance < UPGRADE_MIN_CHANCE || chance > UPGRADE_MAX_CHANCE) {
            throw { status: 400, message: `Шанс должен быть от ${UPGRADE_MIN_CHANCE} до ${UPGRADE_MAX_CHANCE}%` };
        }
        const multiplier = upgradeMultiplier(chance);

        const tx = db.transaction(() => {
            const user = getOrCreateUser(req.telegramUser);
            const stakeValue = validateBet(req.body.bet, user.coins_balance);
            debit(user.id, stakeValue, 'game_bet');

            const { win, roll } = playUpgrade(chance);
            const serverSeed = crypto.randomBytes(16).toString('hex');

            let payoutCoins = 0;
            let newBalance = db.prepare(`SELECT coins_balance FROM users WHERE id = ?`).get(user.id).coins_balance;

            if (win) {
                payoutCoins = Math.max(0, Math.round(stakeValue * multiplier));
                newBalance = credit(user.id, payoutCoins, 'game_win');
            }

            logRound(user.id, 'upgrade', stakeValue, payoutCoins, multiplier, win ? 'win' : 'lose',
                { chance, roll }, serverSeed);

            return { win, roll, chance, multiplier, payoutCoins, newBalance };
        });

        res.json({ success: true, ...tx() });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка апгрейда' });
    }
}

/* ================================ WHEEL ================================ */
// Колесо удачи: одна ставка — одно вращение, сервер сразу отдаёт сектор
// и множитель, клиент только анимирует поворот на нужный угол.
function wheelPlay(req, res) {
    try {
        const tx = db.transaction(() => {
            const user = getOrCreateUser(req.telegramUser);
            const bet = validateBet(req.body.bet, user.coins_balance);

            const { segmentIndex, multiplier } = playWheel();
            const payout = Math.round(bet * multiplier);
            const serverSeed = crypto.randomBytes(16).toString('hex');

            debit(user.id, bet, 'game_bet');
            const newBalance = credit(user.id, payout, 'game_win');
            logRound(user.id, 'wheel', bet, payout, multiplier, payout >= bet ? 'win' : 'lose', { segmentIndex }, serverSeed);

            return { segmentIndex, multiplier, payout, newBalance };
        });

        res.json({ success: true, ...tx(), segments: WHEEL_SEGMENTS });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка игры' });
    }
}

module.exports = {
    crashState, crashBet, crashCashout,
    minesStart, minesStatus, minesReveal, minesCashout,
    plinkoPlay,
    towersStart, towersStatus, towersPick, towersCashout,
    upgradePlay,
    wheelPlay,
    WHEEL_SEGMENTS,
};
