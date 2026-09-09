const db = require('../db/database');
const { getOrCreateUser, invalidateUserCache } = require('./userService');

const CASHBACK_PERCENT = 5;
const CENTISTARS_PER_STAR = 100;
const MIN_WITHDRAW_STARS = 30;

function toPiggyBankView(centistars) {
    const cents = Math.max(0, Number(centistars) || 0);
    const withdrawableStars = Math.floor(cents / CENTISTARS_PER_STAR);
    return {
        centistars: cents,
        balance: cents / CENTISTARS_PER_STAR,
        withdrawableStars,
        canWithdraw: withdrawableStars >= MIN_WITHDRAW_STARS,
        minimumWithdrawal: MIN_WITHDRAW_STARS,
    };
}

/** Начисляет 5% только от игровой ставки; кейсы этот метод не вызывают. */
async function accruePiggyBank(userId, wager, executor = db) {
    const amount = Math.floor(Number(wager));
    if (!Number.isInteger(amount) || amount <= 0) return toPiggyBankView(0);
    const updated = await executor.get(`
        UPDATE users SET piggy_bank_centistars = piggy_bank_centistars + ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? RETURNING piggy_bank_centistars
    `, [amount * CASHBACK_PERCENT, userId]);
    if (!updated) throw new Error('Пользователь для копилки не найден');
    return toPiggyBankView(updated.piggy_bank_centistars);
}

async function getPiggyBank(telegramUser) {
    const user = await getOrCreateUser(telegramUser);
    const row = await db.get(`SELECT piggy_bank_centistars FROM users WHERE id = ?`, [user.id]);
    return toPiggyBankView(row?.piggy_bank_centistars);
}

async function withdrawPiggyBank(telegramUser) {
    return db.transaction(async (tx) => {
        const user = await getOrCreateUser(telegramUser, tx);
        const row = await tx.get(`SELECT piggy_bank_centistars FROM users WHERE id = ?`, [user.id]);
        const before = toPiggyBankView(row?.piggy_bank_centistars);
        const payout = before.withdrawableStars;
        if (payout < MIN_WITHDRAW_STARS) {
            const err = new Error(`Для вывода нужно накопить минимум ${MIN_WITHDRAW_STARS} ⭐.`);
            err.status = 400;
            throw err;
        }
        const spentCentistars = payout * CENTISTARS_PER_STAR;
        const updated = await tx.get(`
            UPDATE users SET piggy_bank_centistars = piggy_bank_centistars - ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND piggy_bank_centistars >= ? RETURNING piggy_bank_centistars
        `, [spentCentistars, user.id, spentCentistars]);
        if (!updated) {
            const err = new Error('Копилка уже изменилась. Обновите экран и повторите попытку.');
            err.status = 409;
            throw err;
        }
        const credited = await tx.get(`
            UPDATE users SET coins_balance = coins_balance + ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? RETURNING coins_balance
        `, [payout, user.id]);
        const newBalance = credited.coins_balance;
        await tx.run(`
            INSERT INTO transactions (user_id, type, amount_coins, balance_after)
            VALUES (?, 'piggybank_withdraw', ?, ?)
        `, [user.id, payout, newBalance]);
        invalidateUserCache(user.id);
        return { payout, newBalance, piggyBank: toPiggyBankView(updated.piggy_bank_centistars) };
    });
}

module.exports = { CASHBACK_PERCENT, MIN_WITHDRAW_STARS, accruePiggyBank, getPiggyBank, withdrawPiggyBank };
