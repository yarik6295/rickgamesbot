const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const telegramAuth = require('../middleware/telegramAuth');
const { listCases, getCaseDetails, openCase } = require('../controllers/caseController');

// Ограничиваем частоту открытия кейсов, чтобы затруднить брутфорс/абьюз.
//
// БАГ (исправлено): ключ лимитера по умолчанию — req.ip, а не пользователь
// (та же проблема, что была в games.routes.js — см. комментарий там). За
// одним NAT/dev-хостом лимит "5 открытий / 10с" был общим на ВСЕХ
// пользователей сразу, что не только неверно считает абьюз, но и создаёт
// ложные 429 для ни в чём не повинных игроков.
const openCaseLimiter = rateLimit({
    windowMs: 10 * 1000,
    max: 5,
    keyGenerator: (req) => (req.telegramUser?.id ? `u:${req.telegramUser.id}` : req.ip),
    message: { error: 'Слишком много запросов на открытие кейса. Подождите немного.' },
});

// Список/детали кейсов тоже требуют авторизации — иначе нельзя посчитать
// для конкретного пользователя, доступен ли ему бесплатный кейс прямо сейчас
// (кулдаун 24ч хранится per-user).
router.get('/', telegramAuth, listCases);
router.get('/:slug', telegramAuth, getCaseDetails);
router.post('/:slug/open', telegramAuth, openCaseLimiter, openCase);

module.exports = router;
