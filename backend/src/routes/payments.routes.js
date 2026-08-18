const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const telegramAuth = require('../middleware/telegramAuth');
const db = require('../db/database');
const { getOrCreateUser, invalidateUserCache } = require('../services/userService');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const MAX_TOPUP_AMOUNT = Number(process.env.MAX_TOPUP_AMOUNT || 1000000);
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

function botApiUrl(method) {
    if (!BOT_TOKEN) throw new Error('BOT_TOKEN не задан');
    return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function callBotApi(method, body) {
    const response = await fetch(botApiUrl(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(data.description || `Telegram Bot API error (${response.status})`);
    }
    return data.result;
}

/**
 * POST /api/user/topup/invoice
 * Создаёт одноразовый invoice link в Telegram Stars (XTR).
 */
router.post('/topup/invoice', async (req, res) => {
    const amount = Math.floor(Number(req.body?.amount));

    if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Сумма должна быть положительным целым числом Stars' });
    }
    if (amount > MAX_TOPUP_AMOUNT) {
        return res.status(400).json({ error: `Максимум за одно пополнение: ${MAX_TOPUP_AMOUNT} ⭐` });
    }
    if (!BOT_TOKEN) {
        return res.status(500).json({ error: 'На сервере не настроен BOT_TOKEN' });
    }

    const user = await getOrCreateUser(req.telegramUser);
    const paymentId = crypto.randomUUID();
    const payload = `topup:${paymentId}`;

    await db.run(`
        INSERT INTO star_payments
            (payment_id, user_id, telegram_id, stars_amount, payload, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
    `, [paymentId, user.id, Number(req.telegramUser.id), amount, payload]);

    try {
        const invoiceLink = await callBotApi('createInvoiceLink', {
            title: 'Пополнение игрового баланса',
            description: `Пополнение виртуального игрового баланса на ${amount} ⭐`,
            payload,
            currency: 'XTR',
            prices: [{ label: `Игровой баланс: ${amount} ⭐`, amount }],
        });

        res.json({ success: true, paymentId, amount, invoiceLink });
    } catch (error) {
        await db.run(`
            UPDATE star_payments SET status = 'cancelled'
            WHERE payment_id = ? AND status = 'pending'
        `, [paymentId]);
        throw error;
    }
});

/**
 * GET /api/user/topup/status/:paymentId
 * Клиент не начисляет баланс сам: только читает результат обработки webhook.
 */
router.get('/topup/status/:paymentId', async (req, res) => {
    const user = await getOrCreateUser(req.telegramUser);
    const payment = await db.get(`
        SELECT payment_id, stars_amount, status, paid_at
        FROM star_payments
        WHERE payment_id = ? AND user_id = ?
    `, [req.params.paymentId, user.id]);

    if (!payment) return res.status(404).json({ error: 'Платёж не найден' });

    const freshUser = await getOrCreateUser(req.telegramUser);
    res.json({
        paymentId: payment.payment_id,
        amount: Number(payment.stars_amount),
        status: payment.status,
        paidAt: payment.paid_at || null,
        newBalance: freshUser.coins_balance,
    });
});

/**
 * Telegram webhook.
 * Обрабатываем pre_checkout_query и successful_payment.
 * Secret token проверяет, что запрос пришёл от настроенного Telegram webhook.
 */
router.post('/telegram/webhook', async (req, res) => {
    if (WEBHOOK_SECRET) {
        const received = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
        if (received !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    }

    const update = req.body || {};

    try {
        if (update.pre_checkout_query) {
            const q = update.pre_checkout_query;
            const payment = await db.get(`
                SELECT payment_id, telegram_id, stars_amount, status
                FROM star_payments
                WHERE payload = ?
            `, [q.invoice_payload]);

            const valid =
                payment &&
                payment.status === 'pending' &&
                Number(payment.telegram_id) === Number(q.from?.id) &&
                Number(payment.stars_amount) === Number(q.total_amount) &&
                q.currency === 'XTR';

            await callBotApi('answerPreCheckoutQuery', {
                pre_checkout_query_id: q.id,
                ok: Boolean(valid),
                ...(valid ? {} : { error_message: 'Платёж недействителен или уже обработан. Попробуйте ещё раз.' }),
            });
        }

        const message = update.message;
        const command = typeof message?.text === 'string' ? message.text.trim().split(/\s+/)[0] : '';
        const chatId = message?.chat?.id;

        if (message && chatId && command === '/paysupport') {
            const support = process.env.SUPPORT_USERNAME
                ? `Напишите в поддержку: @${process.env.SUPPORT_USERNAME.replace(/^@/, '')}`
                : 'Напишите владельцу бота и укажите Telegram ID и дату платежа.';
            await callBotApi('sendMessage', { chat_id: chatId, text: support });
        } else if (message && chatId && command === '/terms') {
            const termsUrl = process.env.TERMS_URL;
            await callBotApi('sendMessage', {
                chat_id: chatId,
                text: termsUrl ? `Условия использования: ${termsUrl}` : 'Условия использования пока не настроены.',
            });
        }

        const successfulPayment = message?.successful_payment;
        const payerId = message?.from?.id;

        if (successfulPayment && payerId) {
            if (successfulPayment.currency !== 'XTR') {
                return res.json({ ok: true });
            }

            await db.transaction(async (tx) => {
                const payment = await tx.get(`
                    SELECT id, payment_id, user_id, telegram_id, stars_amount, status
                    FROM star_payments
                    WHERE payload = ?
                `, [successfulPayment.invoice_payload]);

                if (!payment || payment.status !== 'pending') return;

                if (
                    Number(payment.telegram_id) !== Number(payerId) ||
                    Number(payment.stars_amount) !== Number(successfulPayment.total_amount)
                ) {
                    throw new Error('successful_payment не совпадает с ожидаемым платежом');
                }

                const existingCharge = await tx.get(`
                    SELECT id FROM star_payments
                    WHERE telegram_payment_charge_id = ?
                `, [successfulPayment.telegram_payment_charge_id]);

                if (existingCharge) return;

                const user = await tx.get(`
                    SELECT id, coins_balance FROM users WHERE id = ?
                `, [payment.user_id]);

                if (!user) throw new Error('Пользователь платежа не найден');

                const newBalance = Number(user.coins_balance) + Number(payment.stars_amount);

                await tx.run(`
                    UPDATE users
                    SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `, [newBalance, user.id]);

                await tx.run(`
                    UPDATE star_payments
                    SET status = 'paid',
                        telegram_payment_charge_id = ?,
                        paid_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND status = 'pending'
                `, [successfulPayment.telegram_payment_charge_id, payment.id]);

                await tx.run(`
                    INSERT INTO transactions
                        (user_id, type, amount_coins, balance_after, reference_id)
                    VALUES (?, 'self_topup', ?, ?, ?)
                `, [user.id, payment.stars_amount, newBalance, payment.id]);

                invalidateUserCache(user.id);
            });
        }
    } catch (error) {
        // Для успешного платежа 5xx заставляет Telegram повторить webhook.
        // Повторная доставка безопасна благодаря status/charge-id.
        console.error('[telegram webhook]', error);
        return res.status(500).json({ error: 'Webhook processing failed' });
    }

    res.json({ ok: true });
});

module.exports = router;
