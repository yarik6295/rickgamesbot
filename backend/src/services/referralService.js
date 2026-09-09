const db = require('../db/database');
const { getOrCreateUser, invalidateUserCache } = require('./userService');
const { credit } = require('../controllers/gamesController');

const REFERRAL_SIGNUP_BONUS = 10;
const REFERRAL_TOPUP_PERCENT = 20;

function parseReferrerTelegramId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Привязывает пользователя к рефереру только при первом создании аккаунта.
 * Идентификатор из ссылки не даёт возможности изменить уже установленную
 * связь, а самоприглашение отбрасывается до любых записей.
 */
async function registerReferral(telegramUser, rawReferrerTelegramId) {
    const referrerTelegramId = parseReferrerTelegramId(rawReferrerTelegramId);
    if (!referrerTelegramId || Number(telegramUser.id) === referrerTelegramId) {
        return { applied: false };
    }

    return db.transaction(async (tx) => {
        // Реферальный deep-link действует только до первого создания аккаунта.
        const existing = await tx.get(`SELECT id FROM users WHERE telegram_id = ?`, [telegramUser.id]);
        if (existing) return { applied: false };

        const referrer = await tx.get(`SELECT id FROM users WHERE telegram_id = ?`, [referrerTelegramId]);
        if (!referrer) return { applied: false };

        const referred = await getOrCreateUser(telegramUser, tx);
        const linked = await tx.run(`
            INSERT INTO referrals (referrer_user_id, referred_user_id)
            VALUES (?, ?)
            ON CONFLICT(referred_user_id) DO NOTHING
        `, [referrer.id, referred.id]);
        if (linked.changes !== 1) return { applied: false };

        const newBalance = await credit(
            referrer.id,
            REFERRAL_SIGNUP_BONUS,
            'referral_bonus',
            referred.id,
            tx,
        );
        invalidateUserCache(referrer.id);
        return { applied: true, newBalance };
    });
}

/** Начисляет рефереру 20% от подтверждённого Telegram Stars пополнения. */
async function rewardReferralForTopup(payment, executor = db) {
    const referral = await executor.get(`
        SELECT referrer_user_id FROM referrals WHERE referred_user_id = ?
    `, [payment.user_id]);
    if (!referral) return { rewarded: false };

    const amount = Math.floor(Number(payment.stars_amount) * REFERRAL_TOPUP_PERCENT / 100);
    // При пополнении менее 5 Stars целое вознаграждение равно нулю.
    if (amount <= 0) return { rewarded: false };

    // UNIQUE(payment_id) делает выплату идемпотентной даже при повторном
    // webhook от Telegram или повторном запуске обработки платежа.
    const inserted = await executor.run(`
        INSERT INTO referral_commissions (payment_id, referrer_user_id, referred_user_id, amount_coins)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(payment_id) DO NOTHING
    `, [payment.id, referral.referrer_user_id, payment.user_id, amount]);
    if (inserted.changes !== 1) return { rewarded: false };

    const newBalance = await credit(
        referral.referrer_user_id,
        amount,
        'referral_commission',
        payment.id,
        executor,
    );
    invalidateUserCache(referral.referrer_user_id);
    return { rewarded: true, amount, newBalance };
}

async function getReferralStats(telegramUser) {
    const user = await getOrCreateUser(telegramUser);
    const stats = await db.get(`
        SELECT
            COUNT(DISTINCT r.id) AS invited_count,
            COALESCE(SUM(c.amount_coins), 0) AS commission_earned
        FROM referrals r
        LEFT JOIN referral_commissions c ON c.referrer_user_id = r.referrer_user_id
            AND c.referred_user_id = r.referred_user_id
        WHERE r.referrer_user_id = ?
    `, [user.id]);
    return {
        user,
        invitedCount: Number(stats.invited_count),
        commissionEarned: Number(stats.commission_earned),
    };
}

module.exports = {
    REFERRAL_SIGNUP_BONUS,
    REFERRAL_TOPUP_PERCENT,
    registerReferral,
    rewardReferralForTopup,
    getReferralStats,
};
