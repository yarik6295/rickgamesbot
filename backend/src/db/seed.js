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
 */
const db = require('./database');

function tieredPool({ common, uncommon, rare, legendary }) {
    return [
        { value_coins: common, rarity: 'common', weight: 700 },
        { value_coins: uncommon, rarity: 'uncommon', weight: 220 },
        { value_coins: rare, rarity: 'rare', weight: 65 },
        { value_coins: legendary, rarity: 'legendary', weight: 15 },
    ];
}

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
    { slug: 'free_case', name: 'Бесплатный кейс', price_coins: 0, icon_url: '/assets/cases/free.png', min_level: 1, items: FREE_CASE_ITEMS },
    { slug: 'case_1', name: 'Кейс I', price_coins: 50, icon_url: '/assets/cases/case1.png', min_level: 1, items: tieredPool({ common: 20, uncommon: 50, rare: 125, legendary: 400 }) },
    { slug: 'case_2', name: 'Кейс II', price_coins: 100, icon_url: '/assets/cases/case2.png', min_level: 1, items: tieredPool({ common: 40, uncommon: 100, rare: 250, legendary: 800 }) },
    { slug: 'case_3', name: 'Кейс III', price_coins: 200, icon_url: '/assets/cases/case3.png', min_level: 1, items: tieredPool({ common: 80, uncommon: 200, rare: 500, legendary: 1600 }) },
    { slug: 'case_4', name: 'Кейс IV', price_coins: 500, icon_url: '/assets/cases/case4.png', min_level: 1, items: tieredPool({ common: 200, uncommon: 500, rare: 1250, legendary: 4000 }) },
    { slug: 'case_5', name: 'Кейс V', price_coins: 950, icon_url: '/assets/cases/case5.png', min_level: 1, items: tieredPool({ common: 380, uncommon: 950, rare: 2375, legendary: 7600 }) },
];

// Старые демо-кейсы прошлой версии — если остались в базе, деактивируем их.
const LEGACY_SLUGS = [
    'frog_case', 'candle_case', 'gorilla_case', 'rose_case',
    'ring_case', 'bulkster_case', 'cap_case', 'legendary_case', 'upgrade_rewards',
];

async function seed() {
    await db.transaction(async (tx) => {
        for (const c of CASES) {
            await tx.run(`
                INSERT INTO cases (slug, name, price_coins, icon_url, min_level, is_active)
                VALUES (?, ?, ?, ?, ?, 1)
                ON CONFLICT(slug) DO UPDATE SET
                    name=excluded.name, price_coins=excluded.price_coins,
                    icon_url=excluded.icon_url, min_level=excluded.min_level, is_active=1
            `, [c.slug, c.name, c.price_coins, c.icon_url, c.min_level]);

            const caseRow = await tx.get(`SELECT id FROM cases WHERE slug = ?`, [c.slug]);
            await tx.run(`DELETE FROM case_items WHERE case_id = ?`, [caseRow.id]);
            for (const item of c.items) {
                await tx.run(`
                    INSERT INTO case_items (case_id, value_coins, rarity, weight)
                    VALUES (?, ?, ?, ?)
                `, [caseRow.id, item.value_coins, item.rarity, item.weight]);
            }
            console.log(`✔ Кейс "${c.name}" наполнен ${c.items.length} тирами наград`);
        }
        for (const slug of LEGACY_SLUGS) {
            await tx.run(`UPDATE cases SET is_active = 0 WHERE slug = ?`, [slug]);
        }
    });
}

module.exports = seed;

if (require.main === module) {
    seed()
        .then(() => {
            console.log('Seed завершён успешно.');
            process.exit(0);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
