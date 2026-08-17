const db = require('../db/database');
const { rollWeightedItem } = require('../services/rngService');
const { getOrCreateUser, computeLevel } = require('../services/userService');

const FREE_CASE_SLUG = 'free_case';
const FREE_CASE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Статус доступности бесплатного кейса для конкретного пользователя.
 */
function freeCaseStatus(user) {
    if (!user.last_free_case_at) return { available: true, nextAt: null };
    const last = new Date(user.last_free_case_at).getTime();
    const nextAt = last + FREE_CASE_COOLDOWN_MS;
    return { available: Date.now() >= nextAt, nextAt };
}

function decorateCase(caseRow, user) {
    if (caseRow.slug !== FREE_CASE_SLUG) return { ...caseRow, isFree: false };
    const status = freeCaseStatus(user);
    return { ...caseRow, isFree: true, freeCaseAvailable: status.available, freeCaseNextAt: status.nextAt };
}

/**
 * GET /api/cases
 */
async function listCases(req, res) {
    const user = await getOrCreateUser(req.telegramUser);
    const cases = await db.all(`
        SELECT id, slug, name, price_coins, icon_url, min_level
        FROM cases WHERE is_active = 1 ORDER BY price_coins ASC
    `);
    res.json({ cases: cases.map((c) => decorateCase(c, user)) });
}

/**
 * GET /api/cases/:slug
 */
async function getCaseDetails(req, res) {
    const user = await getOrCreateUser(req.telegramUser);
    const caseRow = await db.get(`SELECT * FROM cases WHERE slug = ? AND is_active = 1`, [req.params.slug]);
    if (!caseRow) return res.status(404).json({ error: 'Кейс не найден' });

    const items = await db.all(`
        SELECT id, value_coins, rarity
        FROM case_items WHERE case_id = ? ORDER BY value_coins ASC
    `, [caseRow.id]);

    res.json({ case: decorateCase(caseRow, user), items });
}

/**
 * POST /api/cases/:slug/open
 * Списание виртуальных звёзд (кроме бесплатного кейса), server-side RNG,
 * выигрыш сразу зачисляется на баланс — никаких "подарков"/инвентаря.
 */
async function openCase(req, res) {
    const { slug } = req.params;

    try {
        const result = await db.transaction(async (tx) => {
            const telegramUser = req.telegramUser;
            const user = await getOrCreateUser(telegramUser, tx);

            const caseRow = await tx.get(`SELECT * FROM cases WHERE slug = ? AND is_active = 1`, [slug]);
            if (!caseRow) throw { status: 404, message: 'Кейс не найден или отключён' };
            if (user.account_level < caseRow.min_level) {
                throw { status: 403, message: `Для этого кейса требуется уровень ${caseRow.min_level}` };
            }

            const isFreeCase = caseRow.slug === FREE_CASE_SLUG;
            if (isFreeCase) {
                const status = freeCaseStatus(user);
                if (!status.available) {
                    throw { status: 429, message: 'Бесплатный кейс уже открыт сегодня. Возвращайтесь через 24 часа.', nextAt: status.nextAt };
                }
            } else if (user.coins_balance < caseRow.price_coins) {
                throw { status: 402, message: 'Недостаточно звёзд на балансе' };
            }

            const items = await tx.all(`
                SELECT id, value_coins, rarity, weight
                FROM case_items WHERE case_id = ?
            `, [caseRow.id]);
            if (items.length === 0) throw { status: 500, message: 'У кейса не настроен пул наград' };

            // Списание цены кейса (бесплатный кейс — цена 0, списывать нечего)
            let balanceAfterDebit = user.coins_balance;
            if (caseRow.price_coins > 0) {
                balanceAfterDebit = user.coins_balance - caseRow.price_coins;
                await tx.run(`UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [balanceAfterDebit, user.id]);
                await tx.run(`
                    INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id)
                    VALUES (?, 'case_open', ?, ?, ?)
                `, [user.id, -caseRow.price_coins, balanceAfterDebit, caseRow.id]);
            }

            const { item: wonTier, rollValue, serverSeed } = rollWeightedItem(items);

            // Выигрыш сразу зачисляется на баланс
            const newBalance = balanceAfterDebit + wonTier.value_coins;
            await tx.run(`UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [newBalance, user.id]);
            await tx.run(`
                INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id)
                VALUES (?, 'case_open', ?, ?, ?)
            `, [user.id, wonTier.value_coins, newBalance, caseRow.id]);

            await tx.run(`
                INSERT INTO case_open_logs (user_id, case_id, result_item_id, server_seed, roll_value)
                VALUES (?, ?, ?, ?, ?)
            `, [user.id, caseRow.id, wonTier.id, serverSeed, rollValue]);

            if (isFreeCase) {
                await tx.run(`UPDATE users SET last_free_case_at = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);
            }

            const casesOpened = user.cases_opened + 1;
            const newLevel = computeLevel(casesOpened);
            await tx.run(`UPDATE users SET cases_opened = ?, account_level = ? WHERE id = ?`, [casesOpened, newLevel, user.id]);

            return {
                reward: { value_coins: wonTier.value_coins, rarity: wonTier.rarity },
                newBalance,
                casesOpened,
                accountLevel: newLevel,
                freeCaseNextAt: isFreeCase ? Date.now() + FREE_CASE_COOLDOWN_MS : undefined,
                reelPool: items.map((i) => ({ id: i.id, value_coins: i.value_coins, rarity: i.rarity })),
            };
        });

        res.json({ success: true, ...result });
    } catch (err) {
        const status = err.status || 500;
        console.error('openCase error:', err);
        res.status(status).json({ error: err.message || 'Внутренняя ошибка сервера', nextAt: err.nextAt });
    }
}

module.exports = { listCases, getCaseDetails, openCase };
