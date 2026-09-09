const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const telegramAuth = require('../middleware/telegramAuth');
const { createPromoCode, redeemPromoCode, cancelPromoCode, getMyPromos } = require('../services/promoService');

router.use(telegramAuth);

// БАГ-ФИКС: в отличие от cases.routes.js и games.routes.js, эти роуты были
// вообще без лимитера — /redeem, в частности, перебирает 12-символьный код
// без троттлинга. Тот же паттерн ключа (по telegramUser.id, а не req.ip),
// что уже применён в openCaseLimiter, чтобы не ловить чужой лимит за NAT.
const promoLimiter = rateLimit({
    windowMs: 10 * 1000,
    max: 5,
    keyGenerator: (req) => (req.telegramUser?.id ? `u:${req.telegramUser.id}` : req.ip),
    message: { error: 'Слишком много запросов к промокодам. Подождите немного.' },
});
router.use(promoLimiter);

router.post('/create', async (req, res) => {
    const result = await createPromoCode(req.telegramUser, req.body?.amount, req.body?.maxUses);
    res.json({ success: true, ...result });
});

router.post('/redeem', async (req, res) => {
    const result = await redeemPromoCode(req.telegramUser, req.body?.code);
    res.json({ success: true, ...result });
});

router.post('/cancel', async (req, res) => {
    const result = await cancelPromoCode(req.telegramUser, req.body?.promoId);
    res.json({ success: true, ...result });
});

router.get('/mine', async (req, res) => {
    const promos = await getMyPromos(req.telegramUser);
    res.json({ promos });
});

module.exports = router;
