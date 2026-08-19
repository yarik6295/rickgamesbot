const crypto = require('crypto');
const db = require('../db/database');
const { getOrCreateUser, invalidateUserCache } = require('./userService');

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

        await tx.run(`
            INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id)
            VALUES (?, 'promo_create', ?, ?, ?)
        `, [user.id, -reserved, newBalance, inserted.lastInsertRowid]);

        invalidateUserCache(user.id);
        return { code, amount, maxUses, reserved, newBalance };
    });
}

async function redeemPromoCode(telegramUser, rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(code)) {
        const err = new Error('Неверный формат промокода.');
        err.status = 400;
        throw err;
    }

    return db.transaction(async (tx) => {
        const user = await getOrCreateUser(telegramUser, tx);
        const promo = await tx.get(`
            SELECT id, code, creator_user_id, amount_coins, max_uses, used_uses, status
            FROM promo_codes WHERE code = ?
        `, [code]);

        if (!promo || promo.status !== 'active' || Number(promo.used_uses) >= Number(promo.max_uses)) {
            const err = new Error('Промокод не найден или уже полностью использован.');
            err.status = 400;
            throw err;
        }
        if (Number(promo.creator_user_id) === Number(user.id)) {
            const err = new Error('Нельзя активировать собственный промокод.');
            err.status = 400;
            throw err;
        }

        const already = await tx.get(`
            SELECT id FROM promo_redemptions WHERE promo_id = ? AND user_id = ?
        `, [promo.id, user.id]);
        if (already) {
            const err = new Error('Ты уже активировал этот промокод.');
            err.status = 400;
            throw err;
        }

        const newBalance = Number(user.coins_balance) + Number(promo.amount_coins);
        const nextUsed = Number(promo.used_uses) + 1;
        const nextStatus = nextUsed >= Number(promo.max_uses) ? 'exhausted' : 'active';

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

        await tx.run(`
            INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id)
            VALUES (?, 'promo_redeem', ?, ?, ?)
        `, [user.id, promo.amount_coins, newBalance, promo.id]);

        invalidateUserCache(user.id);
        return {
            code: promo.code,
            amount: Number(promo.amount_coins),
            usedUses: nextUsed,
            maxUses: Number(promo.max_uses),
            newBalance,
        };
    });
}

async function getMyPromos(telegramUser) {
    const user = await getOrCreateUser(telegramUser);
    return db.all(`
        SELECT code, amount_coins, max_uses, used_uses, status, created_at
        FROM promo_codes
        WHERE creator_user_id = ?
        ORDER BY created_at DESC
        LIMIT 30
    `, [user.id]);
}

module.exports = { createPromoCode, redeemPromoCode, getMyPromos };
