/**
 * Наполняет базу кейсами и пулом наград.
 * Запуск: npm run seed
 *
 * Награда кейса — это ПРОСТО звёзды (виртуальная валюта), без "подарков"/
 * коллекционных предметов и без инвентаря. Выигрыш сразу зачисляется на
 * баланс пользователя.
 *
 * Drop rate настраивается через поле `weight`.
 * Итоговый шанс тира = weight / SUM(weight по кейсу).
 *
 * Все кейсы имеют min_level: 1 — доступны сразу всем пользователям,
 * без прогресса/разблокировки по уровню аккаунта.
 *
 * Кейс `free_case` — бесплатный, price_coins: 0, доступен раз в 24 часа
 * (кулдаун считается на сервере в caseController.js по users.last_free_case_at).
 */
const db = require('./database');

/**
 * Строит пул наград из 4 тиров как долю от цены кейса:
 * common (мелкий утешительный приз), uncommon, rare, legendary (джекпот).
 */
function tieredPool({ common, uncommon, rare, legendary }) {
    return [
        { value_coins: common, rarity: 'common', weight: 700 },
        { value_coins: uncommon, rarity: 'uncommon', weight: 220 },
        { value_coins: rare, rarity: 'rare', weight: 65 },
        { value_coins: legendary, rarity: 'legendary', weight: 15 },
    ];
}

// Пул бесплатного кейса задан вручную (не через tieredPool) по прямому ТЗ:
// 7 тиров вместо стандартных 4. weight = проценты шанса, как их указали
// (30/25/20/7/5/2/1 — в сумме 90, а не 100; RNG в rngService нормализует
// шанс делением на СУММУ весов пула, так что распределение всё равно
// корректно суммируется в 100% — просто итоговые проценты будут чуть выше
// написанных: 33.3/27.8/22.2/7.8/5.6/2.2/1.1%. Если нужны ровно
// 30/25/20/7/5/2/1/13(остаток) — дайте знать, поправлю недостающие 10%.
const FREE_CASE_ITEMS = [
    { value_coins: 1, rarity: 'common', weight: 30 },
    { value_coins: 2, rarity: 'common', weight: 25 },
    { value_coins: 5, rarity: 'uncommon', weight: 20 },
    { value_coins: 10, rarity: 'rare', weight: 7 },
    { value_coins: 25, rarity: 'rare', weight: 5 },
    { value_coins: 50, rarity: 'epic', weight: 2 },
    { value_coins: 100, rarity: 'legendary', weight: 1 },
];

const CASES = [
    {
        slug: 'free_case',
        name: 'Бесплатный кейс',
        price_coins: 0,
        icon_url: '/assets/cases/free.png',
        min_level: 1,
        items: FREE_CASE_ITEMS,
    },
    {
        slug: 'case_1',
        name: 'Кейс I',
        price_coins: 50,
        icon_url: '/assets/cases/case1.png',
        min_level: 1,
        items: tieredPool({ common: 20, uncommon: 50, rare: 125, legendary: 400 }),
    },
    {
        slug: 'case_2',
        name: 'Кейс II',
        price_coins: 100,
        icon_url: '/assets/cases/case2.png',
        min_level: 1,
        items: tieredPool({ common: 40, uncommon: 100, rare: 250, legendary: 800 }),
    },
    {
        slug: 'case_3',
        name: 'Кейс III',
        price_coins: 200,
        icon_url: '/assets/cases/case3.png',
        min_level: 1,
        items: tieredPool({ common: 80, uncommon: 200, rare: 500, legendary: 1600 }),
    },
    {
        slug: 'case_4',
        name: 'Кейс IV',
        price_coins: 500,
        icon_url: '/assets/cases/case4.png',
        min_level: 1,
        items: tieredPool({ common: 200, uncommon: 500, rare: 1250, legendary: 4000 }),
    },
    {
        slug: 'case_5',
        name: 'Кейс V',
        price_coins: 950,
        icon_url: '/assets/cases/case5.png',
        min_level: 1,
        items: tieredPool({ common: 380, uncommon: 950, rare: 2375, legendary: 7600 }),
    },
];

const insertCase = db.prepare(`
    INSERT INTO cases (slug, name, price_coins, icon_url, min_level, is_active)
    VALUES (@slug, @name, @price_coins, @icon_url, @min_level, 1)
    ON CONFLICT(slug) DO UPDATE SET
        name=excluded.name, price_coins=excluded.price_coins,
        icon_url=excluded.icon_url, min_level=excluded.min_level, is_active=1
`);

const getCaseId = db.prepare(`SELECT id FROM cases WHERE slug = ?`);
const clearItems = db.prepare(`DELETE FROM case_items WHERE case_id = ?`);
const insertItem = db.prepare(`
    INSERT INTO case_items (case_id, value_coins, rarity, weight)
    VALUES (@case_id, @value_coins, @rarity, @weight)
`);

// Старые демо-кейсы прошлой версии — если остались в базе, деактивируем их,
// чтобы во вкладке "Кейсы" не висели лишние карточки помимо новых 5+1.
const LEGACY_SLUGS = [
    'frog_case', 'candle_case', 'gorilla_case', 'rose_case',
    'ring_case', 'bulkster_case', 'cap_case', 'legendary_case', 'upgrade_rewards',
];
const deactivateLegacy = db.prepare(`UPDATE cases SET is_active = 0 WHERE slug = ?`);

const seed = db.transaction(() => {
    for (const c of CASES) {
        insertCase.run(c);
        const { id: caseId } = getCaseId.get(c.slug);
        clearItems.run(caseId);
        for (const item of c.items) {
            insertItem.run({ case_id: caseId, ...item });
        }
        console.log(`✔ Кейс "${c.name}" наполнен ${c.items.length} тирами наград`);
    }
    for (const slug of LEGACY_SLUGS) {
        deactivateLegacy.run(slug);
    }
});

// Экспортируем функцию, чтобы сервер мог сам наполнить базу при старте
// (см. server.js) — без этого кейсы появлялись только после ручного
// запуска `npm run seed` в терминале.
module.exports = seed;

// При прямом запуске файла (node src/db/seed.js или npm run seed)
// выполняем сидинг сразу, как раньше.
if (require.main === module) {
    seed();
    console.log('Seed завершён успешно.');
}
