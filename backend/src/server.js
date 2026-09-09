require('dotenv').config();
require('express-async-errors'); // ловит ошибки из async-обработчиков без ручных try/catch везде
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const db = require('./db/database');
const runCasesSeed = require('./db/seed');

// БАГ-ФИКС: раньше DEV_SKIP_TELEGRAM_AUTH=true никак не проверялся при
// старте сервера. Если эту переменную забыть выставить в false (или
// просто не удалить .env) на проде — telegramAuth.js полностью
// отключается, и любой запрос может представиться произвольным
// telegram_id без какой-либо проверки initData. Падаем сразу при старте,
// а не тихо остаёмся уязвимыми в рантайме.
if (process.env.NODE_ENV === 'production' && process.env.DEV_SKIP_TELEGRAM_AUTH === 'true') {
    console.error('[FATAL] DEV_SKIP_TELEGRAM_AUTH=true запрещён при NODE_ENV=production — это отключает проверку Telegram initData для всех запросов.');
    process.exit(1);
}

function warnAboutSingleInstanceLimit() {
    // activeRoundsStore, crashEngine, the short user cache and unrevealed
    // provably-fair commitments intentionally live in this Node process. A
    // second worker would have a different copy, so a load balancer could
    // send two requests from one player to inconsistent game state.
    const configuredCount = Number(
        process.env.APP_INSTANCE_COUNT ||
        process.env.WEB_CONCURRENCY ||
        process.env.PM2_INSTANCES ||
        process.env.CLUSTER_WORKERS ||
        1
    );
    const loadBalancerEnabled = process.env.LOAD_BALANCER_ENABLED === 'true';
    if (configuredCount > 1 || loadBalancerEnabled) {
        console.warn(
            '[WARNING] Single-instance only: обнаружено несколько инстансов/балансировщик. ' +
            'Crash, активные Mines/Towers и in-memory кэш не синхронизируются между процессами. ' +
            'Запускайте один инстанс, пока состояние не будет вынесено в общее хранилище.'
        );
    }
}

async function start() {
    warnAboutSingleInstanceLimit();
    console.log('[db] Применяем схему...');
    await db.init();

    // Сидинг кейсов идемпотентен, прогоняем при каждом старте сервера.
    console.log('[seed] Наполняем/обновляем кейсы...');
    await runCasesSeed();
    console.log('[seed] Готово.');

    const casesRoutes = require('./routes/cases.routes');
    const userRoutes = require('./routes/user.routes');
    const gamesRoutes = require('./routes/games.routes');
    const leaderboardRoutes = require('./routes/leaderboard.routes');
    const paymentsRoutes = require('./routes/payments.routes');
    const promoRoutes = require('./routes/promo.routes');

    const app = express();
    const PORT = process.env.PORT || 3000;

    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(cors());
    app.use(compression());
    app.use(express.json());

    // Отдаём статику фронтенда (для простого деплоя одним процессом)
    app.use(express.static(path.join(__dirname, '../../frontend')));

    app.use('/api/cases', casesRoutes);
    // Telegram Stars: webhook должен быть подключён ДО userRoutes,
    // потому что webhook не содержит Mini App initData.
    app.use('/api/user', paymentsRoutes);
    app.use('/api/user', userRoutes);
    app.use('/api/games', gamesRoutes);
    app.use('/api/leaderboard', leaderboardRoutes);
    app.use('/api/promos', promoRoutes);

    app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

    app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` }));

    // Единая обработка ошибок (в т.ч. { status, message } из throw внутри
    // async-хендлеров — перехватываются благодаря express-async-errors)
    app.use((err, req, res, next) => {
        console.error(err);
        res.status(err.status || 500).json({ error: err.message || 'Внутренняя ошибка сервера' });
    });

    app.listen(PORT, () => {
        console.log(`🎁 Gifts Case Simulator API запущен на http://localhost:${PORT}`);
    });
}

start().catch((err) => {
    console.error('Не удалось запустить сервер:', err);
    process.exit(1);
});
