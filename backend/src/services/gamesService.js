const crypto = require('crypto');

/**
 * Вся логика игр — ТОЛЬКО на сервере. Клиент отправляет лишь намерения
 * (ставка, "открыть клетку X", "заберу выигрыш") и получает уже готовый
 * результат для анимации. Никакой RNG не выполняется и не может быть
 * подделан на клиенте.
 *
 * Валюта — исключительно виртуальные звёзды (coins_balance), без связи
 * с реальными деньгами.
 */

function randomFloat() {
    // криптографически стойкое число в [0, 1)
    return crypto.randomInt(0, 1_000_000_000) / 1_000_000_000;
}

/* ================================ CRASH ================================ */
// Классическая provably-fair формула кривой краша с house edge.
const CRASH_HOUSE_EDGE = 0.04;

function generateCrashPoint() {
    const serverSeed = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(serverSeed).digest('hex');
    const h = parseInt(hash.slice(0, 13), 16);
    const e = Math.pow(2, 52);

    // ~4% шанс мгновенного краша на 1.00x (как и в референсных crash-играх)
    if (h % 33 === 0) {
        return { crashPoint: 1.00, serverSeed };
    }
    let crashPoint = (100 * e - h) / (e - h);
    crashPoint = crashPoint * (1 - CRASH_HOUSE_EDGE) / 100;
    crashPoint = Math.max(1.00, Math.floor(crashPoint * 100) / 100);
    return { crashPoint, serverSeed };
}

/* ================================ MINES ================================ */
function generateMinePositions(gridSize, mineCount) {
    const positions = new Set();
    while (positions.size < mineCount) {
        positions.add(crypto.randomInt(0, gridSize));
    }
    return [...positions];
}

// Мультипликатор за N открытых безопасных клеток при M минах на поле gridSize
function minesMultiplier(gridSize, mineCount, safeRevealed) {
    const HOUSE_EDGE = 0.03;
    let mult = 1;
    for (let i = 0; i < safeRevealed; i++) {
        const safeLeft = gridSize - mineCount - i;
        const cellsLeft = gridSize - i;
        mult *= cellsLeft / safeLeft;
    }
    return Math.round(mult * (1 - HOUSE_EDGE) * 100) / 100;
}

/* ================================ PLINKO ================================ */
// Мультипликаторы по риску (индекс — номер корзины от края к центру)
const PLINKO_MULTIPLIERS = {
    low:    [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high:   [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
};

function playPlinko(risk) {
    const rows = 8; // 8 рядов колышков -> 9 корзин
    const multipliers = PLINKO_MULTIPLIERS[risk] || PLINKO_MULTIPLIERS.medium;
    let position = 0;
    const path = [];
    for (let i = 0; i < rows; i++) {
        const goRight = crypto.randomInt(0, 2) === 1;
        path.push(goRight ? 'R' : 'L');
        if (goRight) position++;
    }
    const bucketIndex = Math.min(position, multipliers.length - 1);
    return { path, bucketIndex, multiplier: multipliers[bucketIndex] };
}

/* ================================ TOWERS ================================ */
// N рядов, в каждом ряду `tilesPerRow` плиток, из них `bombsPerRow` — бомбы.
function generateTowerLayout(rows, tilesPerRow, bombsPerRow) {
    const layout = [];
    for (let r = 0; r < rows; r++) {
        const bombs = new Set();
        while (bombs.size < bombsPerRow) bombs.add(crypto.randomInt(0, tilesPerRow));
        layout.push([...bombs]);
    }
    return layout;
}

function towersMultiplierPerRow(tilesPerRow, bombsPerRow) {
    const HOUSE_EDGE = 0.03;
    const safeTiles = tilesPerRow - bombsPerRow;
    return Math.round((tilesPerRow / safeTiles) * (1 - HOUSE_EDGE) * 100) / 100;
}

/* ================================ UPGRADE ================================ */
// "Апгрейдер": игрок сам выбирает шанс выигрыша (2–90%), множитель считается
// от шанса с фиксированным house edge — чем ниже выбранный шанс, тем выше
// потенциальный множитель. Результат — один крутящийся ролл 1..100.
const UPGRADE_HOUSE_EDGE = 0.08;
const UPGRADE_MIN_CHANCE = 2;
const UPGRADE_MAX_CHANCE = 90;

function upgradeMultiplier(chance) {
    return Math.round((100 / chance) * (1 - UPGRADE_HOUSE_EDGE) * 100) / 100;
}

function playUpgrade(chance) {
    const roll = crypto.randomInt(1, 101); // 1..100 включительно
    const win = roll <= chance;
    return { win, roll, multiplier: upgradeMultiplier(chance) };
}

/* ================================ WHEEL ================================ */
// Колесо удачи: фиксированный набор секторов с весами (провабли-фейр,
// крутится один раз за ставку). Веса подобраны так, чтобы средний RTP
// был около 95% (сектор ×0 — это "пусто", остальное — множитель ставки).
const WHEEL_SEGMENTS = [
    { multiplier: 0,    weight: 87, color: '#2a2d3d' },
    { multiplier: 0.3,  weight: 36, color: '#3a4358' },
    { multiplier: 0.5,  weight: 32, color: '#3f5c86' },
    { multiplier: 1,    weight: 28, color: '#1f8fd6' },
    { multiplier: 1.5,  weight: 20, color: '#1fb894' },
    { multiplier: 2,    weight: 16, color: '#2fe08a' },
    { multiplier: 3,    weight: 10, color: '#ffd83d' },
    { multiplier: 5,    weight: 6,  color: '#ff9d2e' },
    { multiplier: 10,   weight: 3,  color: '#ff2e88' },
    { multiplier: 20,   weight: 1,  color: '#b026ff' },
];

function playWheel() {
    const totalWeight = WHEEL_SEGMENTS.reduce((sum, s) => sum + s.weight, 0);
    const roll = crypto.randomInt(0, totalWeight);
    let cumulative = 0;
    let segmentIndex = WHEEL_SEGMENTS.length - 1;
    for (let i = 0; i < WHEEL_SEGMENTS.length; i++) {
        cumulative += WHEEL_SEGMENTS[i].weight;
        if (roll < cumulative) { segmentIndex = i; break; }
    }
    return { segmentIndex, multiplier: WHEEL_SEGMENTS[segmentIndex].multiplier };
}

module.exports = {
    randomFloat,
    generateCrashPoint,
    generateMinePositions,
    minesMultiplier,
    PLINKO_MULTIPLIERS,
    playPlinko,
    generateTowerLayout,
    towersMultiplierPerRow,
    UPGRADE_MIN_CHANCE,
    UPGRADE_MAX_CHANCE,
    upgradeMultiplier,
    playUpgrade,
    WHEEL_SEGMENTS,
    playWheel,
};
