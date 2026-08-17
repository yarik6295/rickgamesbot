const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const telegramAuth = require('../middleware/telegramAuth');
const games = require('../controllers/gamesController');

router.use(telegramAuth);

// Ограничиваем частоту действий в играх, чтобы затруднить абьюз/бруты.
//
// БАГ (исправлено): раньше один и тот же лимитер вешался на ВСЕ маршруты
// игр и считал запросы по IP. Из-за этого лимит "8 запросов / 2 сек" был
// общим для всех игр сразу — например, пара кликов по клеткам в Mines
// исчерпывала лимит, и следующий же запрос в Plinko/Crash падал с
// "Слишком много запросов", хотя пользователь не абьюзил API, а просто
// играл. К тому же IP-ключ бил по всем пользователям за одним NAT/dev-хостом.
//
// Теперь: ключ — telegram id пользователя (а не IP), лимит ощутимо выше
// и настроен per-route группы, чтобы быстрые действия (открытие клеток
// в Mines/Towers) не упирались в лимит одиночных действий (start/cashout).
function perUserKey(req) {
    return req.telegramUser?.id ? `u:${req.telegramUser.id}` : req.ip;
}

// Одиночные действия (старт раунда, кэшаут, разовые розыгрыши)
const singleActionLimiter = rateLimit({
    windowMs: 3 * 1000,
    max: 12,
    keyGenerator: perUserKey,
    message: { error: 'Слишком много запросов. Помедленнее.' },
});

// Частые действия внутри раунда (клик по клетке в Mines/Towers)
const rapidActionLimiter = rateLimit({
    windowMs: 3 * 1000,
    max: 25,
    keyGenerator: perUserKey,
    message: { error: 'Слишком много запросов. Помедленнее.' },
});

router.get('/crash/state', games.crashState);
router.post('/crash/bet', singleActionLimiter, games.crashBet);
router.post('/crash/cashout', singleActionLimiter, games.crashCashout);

router.post('/mines/start', singleActionLimiter, games.minesStart);
router.get('/mines/status', games.minesStatus);
router.post('/mines/reveal', rapidActionLimiter, games.minesReveal);
router.post('/mines/cashout', singleActionLimiter, games.minesCashout);

router.post('/plinko/play', singleActionLimiter, games.plinkoPlay);

router.post('/towers/start', singleActionLimiter, games.towersStart);
router.get('/towers/status', games.towersStatus);
router.post('/towers/pick', rapidActionLimiter, games.towersPick);
router.post('/towers/cashout', singleActionLimiter, games.towersCashout);

router.post('/upgrade/play', singleActionLimiter, games.upgradePlay);
router.post('/wheel/play', singleActionLimiter, games.wheelPlay);

module.exports = router;
