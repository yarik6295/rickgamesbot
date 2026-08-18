const db = require('../db/database');
const { getOrCreateUser, touchCachedBalance } = require('../services/userService');
const crashEngine = require('../services/crashEngine');
const activeRounds = require('../services/activeRoundsStore');
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
//
// ВАЖНО (исправлена дыра в безопасности): раньше списание делалось в ДВА
// отдельных шага — SELECT текущего баланса, потом отдельный UPDATE с уже
// посчитанным на клиенте Node.js значением. Это классический TOCTOU:
// между чтением и записью есть реальный сетевой промежуток (запрос к
// удалённой Turso), и если в этот промежуток прилетал второй параллельный
// запрос на списание того же пользователя (например, почти одновременный
// старт Mines и Towers, или дублирующийся клик, обошедший фронтовый
// busy-флаг), оба запроса читали ОДИН и тот же исходный баланс, оба
// проходили проверку "хватает ли звёзд" и оба писали свой независимый
// UPDATE — итоговый баланс отражал только ПОСЛЕДНИЙ из них ("потерянное
// обновление"). На практике это означало, что казино можно было обмануть:
// заплатить один раз, а фактически задействовать баланс в двух раундах
// сразу, либо получить более высокий баланс, чем должно быть после серии
// ставок.
//
// ИСПРАВЛЕНИЕ: списание/начисление теперь одно атомарное SQL-выражение
// (`UPDATE ... SET coins_balance = coins_balance ± ? WHERE ... RETURNING
// coins_balance`). Проверка "хватает ли звёзд" встроена прямо в WHERE —
// значит достаточность баланса и само списание проверяются и происходят
// в одной неделимой операции на стороне БД, и это физически исключает
// потерянные обновления при любом количестве параллельных запросов.
// Заодно это на один сетевой round-trip короче (SELECT+UPDATE → просто
// UPDATE...RETURNING), что и было основной причиной ощутимой задержки.
async function debit(userId, amount, type, referenceId = null, executor = db) {
    const updated = await executor.get(`
        UPDATE users SET coins_balance = coins_balance - ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND coins_balance >= ?
        RETURNING coins_balance
    `, [amount, userId, amount]);

    if (!updated) {
        // Либо пользователя не существует, либо (в подавляющем большинстве
        // случаев) баланса действительно не хватает — проверка на клиенте
        // (validateBet по кэшированному балансу) это лишь подсказка для UX,
        // а вот этот запрос — единственный источник истины.
        throw { status: 402, message: 'Недостаточно звёзд на балансе' };
    }

    const newBalance = updated.coins_balance;
    touchCachedBalance(userId, newBalance);
    // Запись в журнал транзакций — аудит/история, на сам баланс уже никак
    // не влияет (он атомарно списан строкой выше), поэтому вне транзакции
    // не блокируем ею ответ игроку (fire-and-forget, как и синхронизация
    // active_rounds в Turso). НО: если debit() вызван ВНУТРИ
    // db.transaction() (executor = tx, см. Plinko/Upgrade/Wheel/кейсы), эту
    // запись обязательно нужно дождаться ДО коммита транзакции — иначе
    // insert может не успеть выполниться до tx.commit() и запись в журнал
    // потеряется молча (или упадёт в закрытую транзакцию).
    const logInsert = executor.run(`INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id) VALUES (?, ?, ?, ?, ?)`,
        [userId, type, -amount, newBalance, referenceId]);
    if (executor === db) {
        logInsert.catch((err) => console.error('[ledger] Не удалось записать транзакцию списания:', err));
    } else {
        await logInsert;
    }
    return newBalance;
}

async function credit(userId, amount, type, referenceId = null, executor = db) {
    const updated = await executor.get(`
        UPDATE users SET coins_balance = coins_balance + ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        RETURNING coins_balance
    `, [amount, userId]);

    const newBalance = updated.coins_balance;
    touchCachedBalance(userId, newBalance);
    if (amount > 0) {
        // См. комментарий в debit() выше — тот же принцип: fire-and-forget
        // только вне транзакции, внутри db.transaction() обязательно ждём.
        const logInsert = executor.run(`INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id) VALUES (?, ?, ?, ?, ?)`,
            [userId, type, amount, newBalance, referenceId]);
        if (executor === db) {
            logInsert.catch((err) => console.error('[ledger] Не удалось записать транзакцию начисления:', err));
        } else {
            await logInsert;
        }
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
    // Фиксируем момент прихода запроса СРАЗУ, до await getOrCreateUser() —
    // см. подробный комментарий в crashEngine.cashout(). Это устраняет ту
    // самую задержку между кликом "Забрать" (и автовыводом) и фактическим
    // моментом, на котором фиксируется мультипликатор.
    const requestedAt = Date.now();
    try {
        const user = await getOrCreateUser(req.telegramUser);
        const result = await crashEngine.cashout(user, requestedAt, req.body?.multiplier);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка вывода', crashPoint: err.crashPoint });
    }
}

/* ================================ MINES ================================
 * Скрытое состояние активного раунда (мины, что уже открыто) держим в
 * памяти процесса (см. services/activeRoundsStore.js) — тот же подход,
 * что и общий раунд Crash в crashEngine.js. Это убирает задержку между
 * тапом по клетке и результатом: раньше на каждый тап уходило 2-3
 * последовательных сетевых запроса к удалённой Turso-базе (получить
 * пользователя, получить строку active_rounds, записать revealed) ДО
 * того, как клиент вообще получал ответ. Теперь ответ формируется сразу
 * из памяти, а в Turso состояние синхронизируется в фоне
 * (fire-and-forget) — только для восстановления раунда после перезагрузки
 * страницы (см. minesStatus).
 */
async function minesStart(req, res) {
    try {
        const user = await getOrCreateUser(req.telegramUser);
        if (activeRounds.get(user.id, 'mines')) {
            throw { status: 409, message: 'У вас уже есть активный раунд Mines' };
        }

        const bet = validateBet(req.body.bet, user.coins_balance);
        const gridSize = 25;
        const mineCount = Math.min(Math.max(Number(req.body.mineCount) || 3, 1), 24);
        const mines = generateMinePositions(gridSize, mineCount);
        const serverSeed = crypto.randomBytes(16).toString('hex');

        // Бронируем слот активного раунда СИНХРОННО, до await debit() — см.
        // подробный комментарий у Crash.placeBet() в crashEngine.js: та же
        // гонка (двойной клик/параллельный запрос мог списать ставку дважды
        // за один раунд, пока идёт поход в БД за списанием) актуальна и тут.
        activeRounds.set(user.id, 'mines', {
            bet, gridSize, mineCount, mines, revealed: [], serverSeed,
        });

        let newBalance;
        try {
            newBalance = await debit(user.id, bet, 'game_bet');
        } catch (err) {
            activeRounds.remove(user.id, 'mines');
            throw err;
        }

        // Запись в Turso нужна только для восстановления состояния после
        // перезагрузки страницы — сам раунд её не ждёт (см. коммент выше).
        db.run(`
            INSERT INTO active_rounds (user_id, game_type, bet_coins, config, hidden_state, revealed, server_seed)
            VALUES (?, 'mines', ?, ?, ?, '[]', ?)
        `, [user.id, bet, JSON.stringify({ gridSize, mineCount }), JSON.stringify({ mines }), serverSeed])
            .catch((err) => console.error('[mines] Не удалось сохранить активный раунд в БД:', err));

        res.json({ success: true, newBalance, gridSize, mineCount });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка запуска раунда' });
    }
}

async function minesReveal(req, res) {
    try {
        const user = await getOrCreateUser(req.telegramUser);
        const session = activeRounds.get(user.id, 'mines');
        if (!session) throw { status: 404, message: 'Нет активного раунда Mines' };

        const tile = Number(req.body.tile);
        if (!Number.isInteger(tile) || tile < 0 || tile >= session.gridSize) {
            throw { status: 400, message: 'Некорректная клетка' };
        }
        if (session.revealed.includes(tile)) throw { status: 400, message: 'Клетка уже открыта' };

        if (session.mines.includes(tile)) {
            activeRounds.remove(user.id, 'mines');
            const revealedAtLoss = session.revealed;
            db.run(`DELETE FROM active_rounds WHERE user_id = ? AND game_type = 'mines'`, [user.id])
                .catch((err) => console.error('[mines] Не удалось удалить активный раунд:', err));
            logRound(user.id, 'mines', session.bet, 0, 0, 'lose',
                { gridSize: session.gridSize, mineCount: session.mineCount, mines: session.mines, revealed: revealedAtLoss },
                session.serverSeed).catch((err) => console.error('[mines] Не удалось записать проигрышный раунд:', err));
            // Баланс на проигрыше не меняется (ставка уже списана на старте) —
            // отдаём его из уже имеющегося в памяти user без похода в БД.
            return res.json({ success: true, hit: true, mines: session.mines, newBalance: user.coins_balance });
        }

        session.revealed.push(tile);
        const multiplier = minesMultiplier(session.gridSize, session.mineCount, session.revealed.length);
        const potentialPayout = Math.floor(session.bet * multiplier);

        db.run(`UPDATE active_rounds SET revealed = ? WHERE user_id = ? AND game_type = 'mines'`,
            [JSON.stringify(session.revealed), user.id])
            .catch((err) => console.error('[mines] Не удалось синхронизировать активный раунд:', err));

        res.json({ success: true, hit: false, revealed: session.revealed, multiplier, potentialPayout });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка открытия клетки' });
    }
}

async function minesStatus(req, res) {
    const user = await getOrCreateUser(req.telegramUser);
    const session = activeRounds.get(user.id, 'mines');
    if (session) {
        const multiplier = session.revealed.length > 0 ? minesMultiplier(session.gridSize, session.mineCount, session.revealed.length) : 1;
        const potentialPayout = session.revealed.length > 0 ? Math.floor(session.bet * multiplier) : 0;
        return res.json({
            active: true, gridSize: session.gridSize, mineCount: session.mineCount,
            bet: session.bet, revealed: session.revealed, multiplier, potentialPayout,
        });
    }

    // В памяти раунда нет (например, сервер перезапустился) — подстраховка
    // из Turso, заодно "прогреваем" память, чтобы дальнейшие клики снова
    // отвечали мгновенно, без похода в БД на каждый тап.
    const round = await db.get(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'mines'`, [user.id]);
    if (!round) return res.json({ active: false });

    const config = JSON.parse(round.config);
    const hidden = JSON.parse(round.hidden_state);
    const revealed = JSON.parse(round.revealed);
    activeRounds.set(user.id, 'mines', {
        bet: round.bet_coins, gridSize: config.gridSize, mineCount: config.mineCount,
        mines: hidden.mines, revealed, serverSeed: round.server_seed,
    });

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
        const session = activeRounds.get(user.id, 'mines');
        if (!session) throw { status: 404, message: 'Нет активного раунда Mines' };
        if (session.revealed.length === 0) throw { status: 400, message: 'Откройте хотя бы одну клетку перед выводом' };

        const multiplier = minesMultiplier(session.gridSize, session.mineCount, session.revealed.length);
        const payout = Math.floor(session.bet * multiplier);

        activeRounds.remove(user.id, 'mines');
        // Начисление выигрыша — реальные деньги (виртуальные звёзды) на
        // балансе, это финальное действие раунда, ждём его по-настоящему.
        const newBalance = await credit(user.id, payout, 'game_win');

        db.run(`DELETE FROM active_rounds WHERE user_id = ? AND game_type = 'mines'`, [user.id])
            .catch((err) => console.error('[mines] Не удалось удалить активный раунд:', err));
        logRound(user.id, 'mines', session.bet, payout, multiplier, 'cashout',
            { gridSize: session.gridSize, mineCount: session.mineCount, mines: session.mines, revealed: session.revealed },
            session.serverSeed).catch((err) => console.error('[mines] Не удалось записать раунд:', err));

        res.json({ success: true, payout, multiplier, newBalance, mines: session.mines });
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

// Как и в Mines (см. коммент там), скрытое состояние активного раунда
// (расклад бомб, пройденные этажи) держим в памяти процесса — на каждый
// тап по плитке больше не тратим время на поход в удалённую Turso-базу.
async function towersStart(req, res) {
    try {
        const user = await getOrCreateUser(req.telegramUser);
        if (activeRounds.get(user.id, 'towers')) {
            throw { status: 409, message: 'У вас уже есть активный раунд Towers' };
        }

        const bet = validateBet(req.body.bet, user.coins_balance);
        const layout = generateTowerLayout(TOWERS_ROWS, TOWERS_TILES_PER_ROW, TOWERS_BOMBS_PER_ROW);
        const serverSeed = crypto.randomBytes(16).toString('hex');

        // См. комментарий у minesStart() выше / Crash.placeBet() — бронируем
        // слот раунда до похода в БД за списанием, чтобы исключить двойное
        // списание при параллельных запросах.
        activeRounds.set(user.id, 'towers', {
            bet, rows: TOWERS_ROWS, tilesPerRow: TOWERS_TILES_PER_ROW, bombsPerRow: TOWERS_BOMBS_PER_ROW,
            layout, revealed: [], serverSeed,
        });

        let newBalance;
        try {
            newBalance = await debit(user.id, bet, 'game_bet');
        } catch (err) {
            activeRounds.remove(user.id, 'towers');
            throw err;
        }

        db.run(`
            INSERT INTO active_rounds (user_id, game_type, bet_coins, config, hidden_state, revealed, server_seed)
            VALUES (?, 'towers', ?, ?, ?, '[]', ?)
        `, [user.id, bet, JSON.stringify({ rows: TOWERS_ROWS, tilesPerRow: TOWERS_TILES_PER_ROW, bombsPerRow: TOWERS_BOMBS_PER_ROW }),
            JSON.stringify({ layout }), serverSeed])
            .catch((err) => console.error('[towers] Не удалось сохранить активный раунд в БД:', err));

        res.json({ success: true, newBalance, rows: TOWERS_ROWS, tilesPerRow: TOWERS_TILES_PER_ROW });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка запуска раунда' });
    }
}

async function towersPick(req, res) {
    try {
        const user = await getOrCreateUser(req.telegramUser);
        const session = activeRounds.get(user.id, 'towers');
        if (!session) throw { status: 404, message: 'Нет активного раунда Towers' };

        const currentRow = session.revealed.length;
        if (currentRow >= session.rows) throw { status: 400, message: 'Башня уже пройдена целиком' };

        const tile = Number(req.body.tile);
        if (!Number.isInteger(tile) || tile < 0 || tile >= session.tilesPerRow) {
            throw { status: 400, message: 'Некорректная клетка' };
        }

        const rowMultiplier = towersMultiplierPerRow(session.tilesPerRow, session.bombsPerRow);

        if (session.layout[currentRow].includes(tile)) {
            activeRounds.remove(user.id, 'towers');
            const revealedAtLoss = session.revealed;
            db.run(`DELETE FROM active_rounds WHERE user_id = ? AND game_type = 'towers'`, [user.id])
                .catch((err) => console.error('[towers] Не удалось удалить активный раунд:', err));
            logRound(user.id, 'towers', session.bet, 0, 0, 'lose',
                { rows: session.rows, tilesPerRow: session.tilesPerRow, bombsPerRow: session.bombsPerRow, layout: session.layout, revealed: revealedAtLoss },
                session.serverSeed).catch((err) => console.error('[towers] Не удалось записать проигрышный раунд:', err));
            return res.json({ success: true, hit: true, layout: session.layout, newBalance: user.coins_balance });
        }

        session.revealed.push(tile);
        const bombPositions = session.layout.slice(0, session.revealed.length).map((row) => row[0]);
        const multiplier = Math.round(Math.pow(rowMultiplier, session.revealed.length) * 100) / 100;
        const potentialPayout = Math.floor(session.bet * multiplier);
        const completed = session.revealed.length >= session.rows;

        if (completed) {
            activeRounds.remove(user.id, 'towers');
            const newBalance = await credit(user.id, potentialPayout, 'game_win');
            db.run(`DELETE FROM active_rounds WHERE user_id = ? AND game_type = 'towers'`, [user.id])
                .catch((err) => console.error('[towers] Не удалось удалить активный раунд:', err));
            logRound(user.id, 'towers', session.bet, potentialPayout, multiplier, 'win',
                { rows: session.rows, tilesPerRow: session.tilesPerRow, bombsPerRow: session.bombsPerRow, revealed: session.revealed },
                session.serverSeed).catch((err) => console.error('[towers] Не удалось записать раунд:', err));
            return res.json({ success: true, hit: false, completed: true, revealed: session.revealed, bombPositions, multiplier, payout: potentialPayout, newBalance });
        }

        db.run(`UPDATE active_rounds SET revealed = ? WHERE user_id = ? AND game_type = 'towers'`,
            [JSON.stringify(session.revealed), user.id])
            .catch((err) => console.error('[towers] Не удалось синхронизировать активный раунд:', err));

        res.json({ success: true, hit: false, completed: false, revealed: session.revealed, bombPositions, multiplier, potentialPayout });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка хода' });
    }
}

async function towersStatus(req, res) {
    const user = await getOrCreateUser(req.telegramUser);
    const session = activeRounds.get(user.id, 'towers');
    if (session) {
        const bombPositions = session.layout.slice(0, session.revealed.length).map((row) => row[0]);
        const rowMultiplier = towersMultiplierPerRow(session.tilesPerRow, session.bombsPerRow);
        const multiplier = session.revealed.length > 0 ? Math.round(Math.pow(rowMultiplier, session.revealed.length) * 100) / 100 : 1;
        const potentialPayout = session.revealed.length > 0 ? Math.floor(session.bet * multiplier) : 0;
        return res.json({
            active: true, rows: session.rows, tilesPerRow: session.tilesPerRow, bet: session.bet,
            currentRow: session.revealed.length, revealed: session.revealed, bombPositions, multiplier, potentialPayout,
        });
    }

    // Подстраховка из Turso (например, после рестарта сервера) — заодно
    // прогреваем память, чтобы дальнейшие тапы снова были мгновенными.
    const round = await db.get(`SELECT * FROM active_rounds WHERE user_id = ? AND game_type = 'towers'`, [user.id]);
    if (!round) return res.json({ active: false });

    const config = JSON.parse(round.config);
    const hidden = JSON.parse(round.hidden_state);
    const revealed = JSON.parse(round.revealed);
    activeRounds.set(user.id, 'towers', {
        bet: round.bet_coins, rows: config.rows, tilesPerRow: config.tilesPerRow, bombsPerRow: config.bombsPerRow,
        layout: hidden.layout, revealed, serverSeed: round.server_seed,
    });

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
        const session = activeRounds.get(user.id, 'towers');
        if (!session) throw { status: 404, message: 'Нет активного раунда Towers' };
        if (session.revealed.length === 0) throw { status: 400, message: 'Пройдите хотя бы один этаж перед выводом' };

        const rowMultiplier = towersMultiplierPerRow(session.tilesPerRow, session.bombsPerRow);
        const multiplier = Math.round(Math.pow(rowMultiplier, session.revealed.length) * 100) / 100;
        const payout = Math.floor(session.bet * multiplier);

        activeRounds.remove(user.id, 'towers');
        const newBalance = await credit(user.id, payout, 'game_win');

        db.run(`DELETE FROM active_rounds WHERE user_id = ? AND game_type = 'towers'`, [user.id])
            .catch((err) => console.error('[towers] Не удалось удалить активный раунд:', err));
        logRound(user.id, 'towers', session.bet, payout, multiplier, 'cashout',
            { rows: session.rows, tilesPerRow: session.tilesPerRow, bombsPerRow: session.bombsPerRow, revealed: session.revealed },
            session.serverSeed).catch((err) => console.error('[towers] Не удалось записать раунд:', err));

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
