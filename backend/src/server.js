require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const db = require('./db/database');
const runCasesSeed = require('./db/seed');

// Сидинг кейсов идемпотентен (ON CONFLICT DO UPDATE + деактивация старых
// слагов), поэтому просто прогоняем его при каждом старте сервера — это
// гарантирует, что после обновления конфигурации кейсов (цены/призы) база
// всегда приводится к актуальному состоянию без ручного запуска `npm run seed`.
console.log('[seed] Наполняем/обновляем кейсы...');
runCasesSeed();
console.log('[seed] Готово.');

const casesRoutes = require('./routes/cases.routes');
const userRoutes = require('./routes/user.routes');
const gamesRoutes = require('./routes/games.routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
// Сжимает ответы (в первую очередь статику фронтенда и более крупные JSON —
// список кейсов/предметов). На мобильных сетях, где round-trip и так не
// самый быстрый, каждый лишний КБ ощущается сильнее, чем на десктопе —
// gzip тут не про CPU, а про то, что меньше байт нужно физически передать.
app.use(compression());
app.use(express.json());

// Отдаём статику фронтенда (для простого деплоя одним процессом)
app.use(express.static(path.join(__dirname, '../../frontend')));

app.use('/api/cases', casesRoutes);
app.use('/api/user', userRoutes);
app.use('/api/games', gamesRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// Отдаём метод и путь в сообщении — иначе на фронте видно только
// нейтральное "Route not found" и невозможно понять, какой запрос улетел
// не туда (например, рассинхрон версий фронта/бэка после деплоя).
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` }));

// Единая обработка ошибок
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
    console.log(`🎁 Gifts Case Simulator API запущен на http://localhost:${PORT}`);
});
