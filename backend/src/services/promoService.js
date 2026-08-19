const crypto = require('crypto');
const db = require('../db/database');
const { getOrCreateUser, invalidateUserCache } = require('./userService');
const { callBotApi } = require('./telegramApi');

function generateCode() {
    return crypto.randomBytes(6).toString('hex').toUpperCase();
}

async function createPromoCode(telegramUser, amount, maxUses) {
    amount = Math.floor(Number(amount));
    maxUses = Math.floor(Number(maxUses));

    if (!Number.isInteger(amount) || amount <= 0) {
        const err = new Error('Сумма должна быть положительным целым числом.');
        err.status = 400;
        throw err;
    }
    if (!Number.isInteger(maxUses) || maxUses <= 0 || maxUses > 1000) {
        const err = new Error('Количество использований должно быть от 1 до 1000.');
        err.status = 400;
        throw err;
    }

    const reserved = amount * maxUses;
    if (!Number.isSafeInteger(reserved)) {
        const err = new Error('Слишком большая сумма.');
        err.status = 400;
        throw err;
    }

    return db.transaction(async (tx) => {
        const user = await getOrCreateUser(telegramUser, tx);

        // Баланс списываем атомарно. Нельзя брать balance из кэша/старого
        // SELECT и потом записывать абсолютное значение: параллельная ставка,
        // пополнение или второй чек могли изменить баланс между этими шагами.
        const reservedRow = await tx.get(`
            UPDATE users
            SET coins_balance = coins_balance - ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND coins_balance >= ?
            RETURNING coins_balance
        `, [reserved, user.id, reserved]);

        if (!reservedRow) {
            const err = new Error(`Недостаточно баланса. Нужно зарезервировать ${reserved} ⭐.`);
            err.status = 400;
            throw err;
        }

        const newBalance = Number(reservedRow.coins_balance);

        let code;
        for (let attempt = 0; attempt < 5; attempt++) {
            const candidate = generateCode();
            const exists = await tx.get(`SELECT id FROM promo_codes WHERE code = ?`, [candidate]);
            if (!exists) {
                code = candidate;
                break;
            }
        }
        if (!code) {
            const err = new Error('Не удалось создать уникальный код. Попробуйте ещё раз.');
            err.status = 500;
            throw err;
        }

        await tx.run(`
            INSERT INTO promo_codes (code, creator_user_id, amount_coins, max_uses, used_uses, status)
            VALUES (?, ?, ?, ?, 0, 'active')
        `, [code, user.id, amount, maxUses]);

        invalidateUserCache(user.id);
        return { code, amount, maxUses, reserved, newBalance };
    });
}

async function redeemPromoCode(telegramUser, rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(code)) {
        const err = new Error('Неверный формат чека.');
        err.status = 400;
        throw err;
    }

    const result = await db.transaction(async (tx) => {
        const user = await getOrCreateUser(telegramUser, tx);
        const promo = await tx.get(`
            SELECT p.id, p.code, p.creator_user_id, p.amount_coins, p.max_uses, p.used_uses, p.status,
                   u.telegram_id AS creator_telegram_id, u.first_name AS creator_first_name, u.username AS creator_username
            FROM promo_codes p
            JOIN users u ON u.id = p.creator_user_id
            WHERE p.code = ?
        `, [code]);

        if (!promo || promo.status !== 'active' || Number(promo.used_uses) >= Number(promo.max_uses)) {
            const err = new Error('Чек не найден или уже полностью использован.');
            err.status = 400;
            throw err;
        }
        if (Number(promo.creator_user_id) === Number(user.id)) {
            const err = new Error('Нельзя активировать собственный чек.');
            err.status = 400;
            throw err;
        }

        const already = await tx.get(`
            SELECT id FROM promo_redemptions WHERE promo_id = ? AND user_id = ?
        `, [promo.id, user.id]);
        if (already) {
            const err = new Error('Ты уже активировал этот чек.');
            err.status = 400;
            throw err;
        }

        // Сначала создаём уникальную запись активации. Если тот же пользователь
        // одновременно отправил несколько запросов, UNIQUE(promo_id,user_id)
        // откатит всю транзакцию и баланс не изменится.
        await tx.run(`
            INSERT INTO promo_redemptions (promo_id, user_id, amount_coins)
            VALUES (?, ?, ?)
        `, [promo.id, user.id, promo.amount_coins]);

        // Одновременно резервируем одну активацию. Условие в WHERE защищает
        // последний доступный слот от гонки нескольких пользователей.
        const claimed = await tx.get(`
            UPDATE promo_codes
            SET used_uses = used_uses + 1,
                status = CASE
                    WHEN used_uses + 1 >= max_uses THEN 'exhausted'
                    ELSE 'active'
                END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND status = 'active'
              AND used_uses < max_uses
            RETURNING used_uses, max_uses, status
        `, [promo.id]);

        if (!claimed) {
            const err = new Error('Чек только что закончился. Попробуйте другой.');
            err.status = 409;
            throw err;
        }

        // Начисление тоже атомарное — никакого SELECT -> вычисление -> UPDATE
        // со старым балансом.
        const credited = await tx.get(`
            UPDATE users
            SET coins_balance = coins_balance + ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            RETURNING coins_balance
        `, [promo.amount_coins, user.id]);

        if (!credited) {
            throw new Error('Не удалось начислить баланс.');
        }

        const newBalance = Number(credited.coins_balance);
        const nextUsed = Number(claimed.used_uses);
        const maxUses = Number(claimed.max_uses);
        const remainingUses = Math.max(0, maxUses - nextUsed);

        invalidateUserCache(user.id);

        return {
            code: promo.code,
            amount: Number(promo.amount_coins),
            usedUses: nextUsed,
            maxUses,
            remainingUses,
            newBalance,
            creatorTelegramId: promo.creator_telegram_id,
            creatorFirstName: promo.creator_first_name,
            creatorUsername: promo.creator_username,
            redeemerFirstName: user.first_name,
            redeemerUsername: user.username,
        };
    });

    if (result.creatorTelegramId) {
        const who = result.redeemerUsername
            ? `@${result.redeemerUsername}`
            : (result.redeemerFirstName || 'Игрок');
        const remaining = result.remainingUses > 0
            ? `Осталось активаций: ${result.remainingUses}`
            : 'Чек полностью использован.';
        try {
            await callBotApi('sendMessage', {
                chat_id: result.creatorTelegramId,
                text: `🎟 Чек активирован!\n\nКод: ${result.code}\nИгрок: ${who}\nНачислено игроку: +${result.amount} ⭐\n${remaining}`,
            });
        } catch (err) {
            console.warn('[promo] Не удалось отправить уведомление создателю:', err.message);
        }
    }

    return result;
}

async function cancelPromoCode(telegramUser, promoId) {
    const id = Number(promoId);
    if (!Number.isInteger(id) || id <= 0) {
        const err = new Error('Некорректный чек.');
        err.status = 400;
        throw err;
    }

    return db.transaction(async (tx) => {
        const user = await getOrCreateUser(telegramUser, tx);

        // Сначала атомарно закрываем чек и получаем фактическое число
        // использованных слотов. Так параллельная активация не позволит
        // вернуть создателю уже выданные звёзды.
        const cancelled = await tx.get(`
            UPDATE promo_codes
            SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND creator_user_id = ? AND status = 'active'
            RETURNING id, code, amount_coins, max_uses, used_uses
        `, [id, user.id]);

        if (!cancelled) {
            const exists = await tx.get(`
                SELECT id FROM promo_codes WHERE id = ? AND creator_user_id = ?
            `, [id, user.id]);
            if (!exists) {
                const err = new Error('Чек не найден.');
                err.status = 404;
                throw err;
            }
            const err = new Error('Этот чек уже использован или деактивирован.');
            err.status = 400;
            throw err;
        }

        const remainingUses = Math.max(
            0,
            Number(cancelled.max_uses) - Number(cancelled.used_uses)
        );
        const refund = remainingUses * Number(cancelled.amount_coins);

        const credited = await tx.get(`
            UPDATE users
            SET coins_balance = coins_balance + ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            RETURNING coins_balance
        `, [refund, user.id]);

        const newBalance = Number(credited.coins_balance);
        invalidateUserCache(user.id);

        return {
            id: cancelled.id,
            code: cancelled.code,
            refund,
            remainingUses,
            newBalance,
        };
    });
}

async function getMyPromos(telegramUser) {
    const user = await getOrCreateUser(telegramUser);
    return db.all(`
        SELECT id, code, amount_coins, max_uses, used_uses, status, created_at
        FROM promo_codes
        WHERE creator_user_id = ?
        ORDER BY created_at DESC
        LIMIT 30
    `, [user.id]);
}

module.exports = { createPromoCode, redeemPromoCode, cancelPromoCode, getMyPromos };
