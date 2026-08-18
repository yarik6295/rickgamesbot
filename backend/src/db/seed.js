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

/**
 * Экономика платных кейсов (пересчитано — раньше RTP был 78.25% почти без
 * разброса по тирам: common терял только 60% ставки, а uncommon вообще
 * возвращал РОВНО цену кейса (0% house edge на 22% открытий), из-за чего
 * "средние" призы ощущались как слишком частая и слишком щедрая окупаемость.
 *
 * Теперь у каждого тира РЕАЛЬНЫЙ отрицательный house edge (даже uncommon —
 * это уже гарантированный минус для игрока, а не размен 1:1), а редкие
 * тиры остаются доходными для игрока, но заметно реже. Итоговый RTP по
 * всем платным кейсам ~56% (house edge ~44%) — кейсы стабильно прибыльны
 * для казино при любом объёме открытий, при этом легендарка (1% шанс,
 * ×6.5 от цены) сохраняет "вау"-момент редкого джекпота.
 *
 * mult:  common ×0.35   (было ×0.4)  — вес 75%
 *        uncommon ×0.7  (было ×1.0!) — вес 19% — раньше был чистый 0% edge
 *        rare ×2.0      (было ×2.5)  — вес 5%
 *        legendary ×6.5 (было ×8.0)  — вес 1%
 * EV = .75*.35 + .19*.7 + .05*2.0 + .01*6.5 = 0.5605 → RTP 56.05%
 */
const TIER_WEIGHTS = { common: 750, uncommon: 190, rare: 50, legendary: 10 };
const TIER_MULT = { common: 0.35, uncommon: 0.7, rare: 2.0, legendary: 6.5 };

// price — цена кейса; значения тиров считаются от неё автоматически, так
// экономика остаётся одинаковой (RTP 56%) для всех кейсов вне зависимости
// от их цены, без риска рассинхронизации при добавлении новых кейсов.
function tieredPool(price) {
    return Object.keys(TIER_WEIGHTS).map((rarity) => ({
        rarity,
        weight: TIER_WEIGHTS[rarity],
        value_coins: Math.max(1, Math.round(price * TIER_MULT[rarity])),
    }));
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
    { slug: 'case_1', name: 'Кейс I', price_coins: 50, icon_url: '/assets/cases/case1.png', min_level: 1, items: tieredPool(50) },
    { slug: 'case_2', name: 'Кейс II', price_coins: 100, icon_url: '/assets/cases/case2.png', min_level: 1, items: tieredPool(100) },
    { slug: 'case_3', name: 'Кейс III', price_coins: 200, icon_url: '/assets/cases/case3.png', min_level: 1, items: tieredPool(200) },
    { slug: 'case_4', name: 'Кейс IV', price_coins: 500, icon_url: '/assets/cases/case4.png', min_level: 1, items: tieredPool(500) },
    { slug: 'case_5', name: 'Кейс V', price_coins: 950, icon_url: '/assets/cases/case5.png', min_level: 1, items: tieredPool(950) },
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
