require('dotenv').config();
require('express-async-errors'); // ловит ошибки из async-обработчиков без ручных try/catch везде
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const db = require('./db/database');
const runCasesSeed = require('./db/seed');

async function start() {
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

    const app = express();
    const PORT = process.env.PORT || 3000;

    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(cors());
    app.use(compression());
    app.use(express.json());

    // Отдаём статику фронтенда (для простого деплоя одним процессом)
    app.use(express.static(path.join(__dirname, '../../frontend')));

    app.use('/api/cases', casesRoutes);
    // ВАЖНО: paymentRoutes ставим раньше userRoutes.
    // /telegram/webhook должен быть доступен без Mini App initData,
    // иначе telegramAuth из userRoutes перехватит webhook и вернёт 401.
    app.use('/api/user', paymentsRoutes);
    app.use('/api/user', userRoutes);
    app.use('/api/games', gamesRoutes);
    app.use('/api/leaderboard', leaderboardRoutes);

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
