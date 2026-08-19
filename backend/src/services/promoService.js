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
        const balance = Number(user.coins_balance);
        if (balance < reserved) {
            const err = new Error(`Недостаточно баланса. Нужно зарезервировать ${reserved} ⭐.`);
            err.status = 400;
            throw err;
        }

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

        const newBalance = balance - reserved;
        await tx.run(`
            UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `, [newBalance, user.id]);

        const inserted = await tx.run(`
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

        const newBalance = Number(user.coins_balance) + Number(promo.amount_coins);
        const nextUsed = Number(promo.used_uses) + 1;
        const nextStatus = nextUsed >= Number(promo.max_uses) ? 'exhausted' : 'active';
        const remainingUses = Math.max(0, Number(promo.max_uses) - nextUsed);

        await tx.run(`
            UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `, [newBalance, user.id]);

        await tx.run(`
            INSERT INTO promo_redemptions (promo_id, user_id, amount_coins)
            VALUES (?, ?, ?)
        `, [promo.id, user.id, promo.amount_coins]);

        await tx.run(`
            UPDATE promo_codes
            SET used_uses = ?, status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'active'
        `, [nextUsed, nextStatus, promo.id]);

        // Не пишем promo_* в transactions: у старых Turso-баз CHECK-ограничение
        // могло быть создано без этих двух значений.
        invalidateUserCache(user.id);

        return {
            code: promo.code,
            amount: Number(promo.amount_coins),
            usedUses: nextUsed,
            maxUses: Number(promo.max_uses),
            remainingUses,
            newBalance,
            creatorTelegramId: promo.creator_telegram_id,
            creatorFirstName: promo.creator_first_name,
            creatorUsername: promo.creator_username,
            redeemerFirstName: user.first_name,
            redeemerUsername: user.username,
        };
    });

    // Уведомление не должно ломать уже успешную активацию, если Telegram
    // временно недоступен или пользователь заблокировал бота.
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
        const promo = await tx.get(`
            SELECT id, code, amount_coins, max_uses, used_uses, status
            FROM promo_codes
            WHERE id = ? AND creator_user_id = ?
        `, [id, user.id]);

        if (!promo) {
            const err = new Error('Чек не найден.');
            err.status = 404;
            throw err;
        }
        if (promo.status !== 'active') {
            const err = new Error('Этот чек уже использован или деактивирован.');
            err.status = 400;
            throw err;
        }

        const remainingUses = Math.max(0, Number(promo.max_uses) - Number(promo.used_uses));
        const refund = remainingUses * Number(promo.amount_coins);
        const newBalance = Number(user.coins_balance) + refund;

        const updated = await tx.run(`
            UPDATE promo_codes
            SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND creator_user_id = ? AND status = 'active'
        `, [promo.id, user.id]);
        if (!updated.changes) {
            const err = new Error('Чек уже изменён. Обнови список и попробуй снова.');
            err.status = 409;
            throw err;
        }

        await tx.run(`
            UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `, [newBalance, user.id]);
        invalidateUserCache(user.id);

        return {
            id: promo.id,
            code: promo.code,
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
