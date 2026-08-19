const express = require('express');
const router = express.Router();
const telegramAuth = require('../middleware/telegramAuth');
const { createPromoCode, redeemPromoCode, cancelPromoCode, getMyPromos } = require('../services/promoService');

router.use(telegramAuth);

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
