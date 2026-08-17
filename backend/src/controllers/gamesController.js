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

// executor — db по умолчанию, либо tx внутри db.transaction(async (tx) => {...})
async function debit(userId, amount, type, referenceId = null, executor = db) {
    const user = await executor.get(`SELECT coins_balance FROM users WHERE id = ?`, [userId]);
    const newBalance = user.coins_balance - amount;
    await executor.run(`UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [newBalance, userId]);
    await executor.run(`INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id) VALUES (?, ?, ?, ?, ?)`,
        [userId, type, -amount, newBalance, referenceId]);
    return newBalance;
}

async function credit(userId, amount, type, referenceId = null, executor = db) {
    const user = await executor.get(`SELECT coins_balance FROM users WHERE id = ?`, [userId]);
    const newBalance = user.coins_balance + amount;
    await executor.run(`UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [newBalance, userId]);
    if (amount > 0) {
        await executor.run(`INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id) VALUES (?, ?, ?, ?, ?)`,
            [userId, type, amount, newBalance, referenceId]);
    }
    return newBalance;
}

async function logRound(userId, gameType, bet, payout, multiplier, outcome, roundData, serverSeed, executor = db) {
    await executor.run(`
        INSERT INTO game_rounds (user_id, game_type, bet_coins, payout_coins, multiplier, outcome, round_data, server_seed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [userId, gameType, bet, payout, multiplier, outcome, JSON.stringify(roundData), serverSeed]);
}

/* ================================ CRASH ================================ */
// Раунд общий и непрерывный для всех игроков (см. services/crashEngine.js) —
// контроллер тут только мост между HTTP и движком.

async function crashState(req, res) {
    const user = await getOrCreateUser(req.telegramUser);
    res.json(crashEngine.getPublicState(user.id));
}

async function crashBet(req, res) {
    try {
        const user = await getOrCreateUser(req.telegramUser);
        const result = await crashEngine.placeBet(user, req.body.bet);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка ставки' });
    }
}

async function crashCashout(req, res) {
    try {
        const user = await getOrCreateUser(req.telegramUser);
        const result = await crashEngine.cashout(user);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка вывода', crashPoint: err.crashPoint });
    }
}

/* ================================ MINES ================================ */
async function minesStart(req, res) {
    try {
        const result = await db.transaction(async (tx) => {
            const user = await getOrCreateUser(req.telegramUser, tx);
            const existing = await tx.get(`SELECT id FROM active_rounds WHERE user_id = ? AND game_type = 'mines'`, [user.id]);
            if (existing) throw { status: 409, message: 'У вас уже есть активный раунд Mines' };

            const bet = validateBet(req.body.bet, user.coins_balance);
            const gridSize = 25;
            const mineCount = Math.min(Math.max(Number(req.body.mineCount) || 3, 1), 24);

            const mines = generateMinePositions(gridSize, mineCount);
            const serverSeed = crypto.randomBytes(16).toString('hex');

            const newBalance = await debit(user.id, bet, 'game_bet', null, tx);

            await tx.run(`
                INSERT INTO active_rounds (user_id, game_type, bet_coins, config, hidden_state, revealed, server_seed)
                VALUES (?, 'mines', ?, ?, ?, '[]', ?)
            `, [user.id, bet, JSON.stringify({ gridSize, mineCount }), JSON.stringify({ mines }), serverSeed]);

            return { newBalance, gridSize, mineCount };
        });

        res.json({ success: true, ...result });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка запуска раунда' });
    }
}

async function minesReveal(req, res) {
    try {
        const user = await getOrCreateUser(req.telegramUser);
        const round = await db.get(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'mines'`, [user.id]);
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
            await db.run(`DELETE FROM active_rounds WHERE id = ?`, [round.id]);
            await logRound(user.id, 'mines', round.bet_coins, 0, 0, 'lose', { ...config, mines: hidden.mines, revealed }, round.server_seed);
            const freshUser = await getOrCreateUser(req.telegramUser);
            return res.json({ success: true, hit: true, mines: hidden.mines, newBalance: freshUser.coins_balance });
        }

        revealed.push(tile);
        await db.run(`UPDATE active_rounds SET revealed = ? WHERE id = ?`, [JSON.stringify(revealed), round.id]);

        const multiplier = minesMultiplier(config.gridSize, config.mineCount, revealed.length);
        const potentialPayout = Math.floor(round.bet_coins * multiplier);

        res.json({ success: true, hit: false, revealed, multiplier, potentialPayout });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка открытия клетки' });
    }
}

async function minesStatus(req, res) {
    const user = await getOrCreateUser(req.telegramUser);
    const round = await db.get(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'mines'`, [user.id]);
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

async function minesCashout(req, res) {
    try {
        const user = await getOrCreateUser(req.telegramUser);
        const round = await db.get(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'mines'`, [user.id]);
        if (!round) throw { status: 404, message: 'Нет активного раунда Mines' };

        const config = JSON.parse(round.config);
        const hidden = JSON.parse(round.hidden_state);
        const revealed = JSON.parse(round.revealed);
        if (revealed.length === 0) throw { status: 400, message: 'Откройте хотя бы одну клетку перед выводом' };

        const multiplier = minesMultiplier(config.gridSize, config.mineCount, revealed.length);
        const payout = Math.floor(round.bet_coins * multiplier);

        await db.run(`DELETE FROM active_rounds WHERE id = ?`, [round.id]);
        const newBalance = await credit(user.id, payout, 'game_win');
        await logRound(user.id, 'mines', round.bet_coins, payout, multiplier, 'cashout', { ...config, mines: hidden.mines, revealed }, round.server_seed);

        res.json({ success: true, payout, multiplier, newBalance, mines: hidden.mines });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка вывода' });
    }
}

/* ================================ PLINKO ================================ */
async function plinkoPlay(req, res) {
    try {
        const result = await db.transaction(async (tx) => {
            const user = await getOrCreateUser(req.telegramUser, tx);
            const bet = validateBet(req.body.bet, user.coins_balance);
            const risk = ['low', 'medium', 'high'].includes(req.body.risk) ? req.body.risk : 'medium';

            const { path, bucketIndex, multiplier } = playPlinko(risk);
            const payout = Math.floor(bet * multiplier);
            const serverSeed = crypto.randomBytes(16).toString('hex');

            await debit(user.id, bet, 'game_bet', null, tx);
            const newBalance = await credit(user.id, payout, 'game_win', null, tx);
            await logRound(user.id, 'plinko', bet, payout, multiplier, payout > bet ? 'win' : 'lose', { risk, path, bucketIndex }, serverSeed, tx);

            return { path, bucketIndex, multiplier, payout, newBalance };
        });

        res.json({ success: true, ...result });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка игры' });
    }
}

/* ================================ TOWERS ================================ */
const TOWERS_ROWS = 8;
const TOWERS_TILES_PER_ROW = 3;
const TOWERS_BOMBS_PER_ROW = 1;

async function towersStart(req, res) {
    try {
        const result = await db.transaction(async (tx) => {
            const user = await getOrCreateUser(req.telegramUser, tx);
            const existing = await tx.get(`SELECT id FROM active_rounds WHERE user_id = ? AND game_type = 'towers'`, [user.id]);
            if (existing) throw { status: 409, message: 'У вас уже есть активный раунд Towers' };

            const bet = validateBet(req.body.bet, user.coins_balance);
            const layout = generateTowerLayout(TOWERS_ROWS, TOWERS_TILES_PER_ROW, TOWERS_BOMBS_PER_ROW);
            const serverSeed = crypto.randomBytes(16).toString('hex');

            const newBalance = await debit(user.id, bet, 'game_bet', null, tx);

            await tx.run(`
                INSERT INTO active_rounds (user_id, game_type, bet_coins, config, hidden_state, revealed, server_seed)
                VALUES (?, 'towers', ?, ?, ?, '[]', ?)
            `, [user.id, bet, JSON.stringify({ rows: TOWERS_ROWS, tilesPerRow: TOWERS_TILES_PER_ROW, bombsPerRow: TOWERS_BOMBS_PER_ROW }),
                JSON.stringify({ layout }), serverSeed]);

            return { newBalance, rows: TOWERS_ROWS, tilesPerRow: TOWERS_TILES_PER_ROW };
        });

        res.json({ success: true, ...result });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка запуска раунда' });
    }
}

async function towersPick(req, res) {
    try {
        const user = await getOrCreateUser(req.telegramUser);
        const round = await db.get(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'towers'`, [user.id]);
        if (!round) throw { status: 404, message: 'Нет активного раунда Towers' };

        const config = JSON.parse(round.config);
        const hidden = JSON.parse(round.hidden_state);
        const revealed = JSON.parse(round.revealed);

        const currentRow = revealed.length;
        if (currentRow >= config.rows) throw { status: 400, message: 'Башня уже пройдена целиком' };

        const tile = Number(req.body.tile);
        if (!Number.isInteger(tile) || tile < 0 || tile >= config.tilesPerRow) {
            throw { status: 400, message: 'Некорректная клетка' };
        }

        const rowMultiplier = towersMultiplierPerRow(config.tilesPerRow, config.bombsPerRow);

        if (hidden.layout[currentRow].includes(tile)) {
            await db.run(`DELETE FROM active_rounds WHERE id = ?`, [round.id]);
            await logRound(user.id, 'towers', round.bet_coins, 0, 0, 'lose', { ...config, layout: hidden.layout, revealed }, round.server_seed);
            const freshUser = await getOrCreateUser(req.telegramUser);
            return res.json({ success: true, hit: true, layout: hidden.layout, newBalance: freshUser.coins_balance });
        }

        revealed.push(tile);
        await db.run(`UPDATE active_rounds SET revealed = ? WHERE id = ?`, [JSON.stringify(revealed), round.id]);

        const bombPositions = hidden.layout.slice(0, revealed.length).map((row) => row[0]);

        const multiplier = Math.round(Math.pow(rowMultiplier, revealed.length) * 100) / 100;
        const potentialPayout = Math.floor(round.bet_coins * multiplier);
        const completed = revealed.length >= config.rows;

        if (completed) {
            await db.run(`DELETE FROM active_rounds WHERE id = ?`, [round.id]);
            const newBalance = await credit(user.id, potentialPayout, 'game_win');
            await logRound(user.id, 'towers', round.bet_coins, potentialPayout, multiplier, 'win', { ...config, revealed }, round.server_seed);
            return res.json({ success: true, hit: false, completed: true, revealed, bombPositions, multiplier, payout: potentialPayout, newBalance });
        }

        res.json({ success: true, hit: false, completed: false, revealed, bombPositions, multiplier, potentialPayout });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка хода' });
    }
}

async function towersStatus(req, res) {
    const user = await getOrCreateUser(req.telegramUser);
    const round = await db.get(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'towers'`, [user.id]);
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

async function towersCashout(req, res) {
    try {
        const user = await getOrCreateUser(req.telegramUser);
        const round = await db.get(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'towers'`, [user.id]);
        if (!round) throw { status: 404, message: 'Нет активного раунда Towers' };

        const config = JSON.parse(round.config);
        const revealed = JSON.parse(round.revealed);
        if (revealed.length === 0) throw { status: 400, message: 'Пройдите хотя бы один этаж перед выводом' };

        const rowMultiplier = towersMultiplierPerRow(config.tilesPerRow, config.bombsPerRow);
        const multiplier = Math.round(Math.pow(rowMultiplier, revealed.length) * 100) / 100;
        const payout = Math.floor(round.bet_coins * multiplier);

        await db.run(`DELETE FROM active_rounds WHERE id = ?`, [round.id]);
        const newBalance = await credit(user.id, payout, 'game_win');
        await logRound(user.id, 'towers', round.bet_coins, payout, multiplier, 'cashout', { ...config, revealed }, round.server_seed);

        res.json({ success: true, payout, multiplier, newBalance });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка вывода' });
    }
}

/* ================================ UPGRADE ================================ */
async function upgradePlay(req, res) {
    try {
        const chance = Number(req.body.chance);
        if (!Number.isInteger(chance) || chance < UPGRADE_MIN_CHANCE || chance > UPGRADE_MAX_CHANCE) {
            throw { status: 400, message: `Шанс должен быть от ${UPGRADE_MIN_CHANCE} до ${UPGRADE_MAX_CHANCE}%` };
        }
        const multiplier = upgradeMultiplier(chance);

        const result = await db.transaction(async (tx) => {
            const user = await getOrCreateUser(req.telegramUser, tx);
            const stakeValue = validateBet(req.body.bet, user.coins_balance);
            await debit(user.id, stakeValue, 'game_bet', null, tx);

            const { win, roll } = playUpgrade(chance);
            const serverSeed = crypto.randomBytes(16).toString('hex');

            let payoutCoins = 0;
            let newBalance = (await tx.get(`SELECT coins_balance FROM users WHERE id = ?`, [user.id])).coins_balance;

            if (win) {
                payoutCoins = Math.max(0, Math.round(stakeValue * multiplier));
                newBalance = await credit(user.id, payoutCoins, 'game_win', null, tx);
            }

            await logRound(user.id, 'upgrade', stakeValue, payoutCoins, multiplier, win ? 'win' : 'lose', { chance, roll }, serverSeed, tx);

            return { win, roll, chance, multiplier, payoutCoins, newBalance };
        });

        res.json({ success: true, ...result });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка апгрейда' });
    }
}

/* ================================ WHEEL ================================ */
async function wheelPlay(req, res) {
    try {
        const result = await db.transaction(async (tx) => {
            const user = await getOrCreateUser(req.telegramUser, tx);
            const bet = validateBet(req.body.bet, user.coins_balance);

            const { segmentIndex, multiplier } = playWheel();
            const payout = Math.round(bet * multiplier);
            const serverSeed = crypto.randomBytes(16).toString('hex');

            await debit(user.id, bet, 'game_bet', null, tx);
            const newBalance = await credit(user.id, payout, 'game_win', null, tx);
            await logRound(user.id, 'wheel', bet, payout, multiplier, payout >= bet ? 'win' : 'lose', { segmentIndex }, serverSeed, tx);

            return { segmentIndex, multiplier, payout, newBalance };
        });

        res.json({ success: true, ...result, segments: WHEEL_SEGMENTS });
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
