const express = require('express');
const router = express.Router();
const db = require('../db/database');
const telegramAuth = require('../middleware/telegramAuth');
const { getOrCreateUser } = require('../services/userService');

router.use(telegramAuth);

const LIMIT = 50;

/**
 * GET /api/leaderboard?period=all|week
 *
 * Рейтинг по СУММЕ ВСЕХ СТАВОК (не по выигрышу/балансу — иначе рейтинг
 * поощрял бы "повезло один раз крупно", а не реальную активность игрока).
 * Считаем по game_rounds.bet_coins — это ставки во всех играх (Crash,
 * Mines, Plinko, Towers, Upgrade, Wheel); открытие кейсов в сумму не
 * включаем, это отдельная механика, а не "ставка" в игре.
 *
 * ВАЖНО: наружу отдаём ТОЛЬКО first_name и photo_url — никакого username/
 * telegram_id, ни на фронте, ни в ответе API (см. запрос пользователя —
 * юзернейм в таблице лидеров быть не должно, только имя и аватар).
 *
 * Игроки с leaderboard_anonymous=1 (по умолчанию у всех) отдаются наружу
 * как "Аноним" без фото — их место и сумма ставок в рейтинге сохраняются,
 * просто имя/аватар скрыты от остальных. Своя же строка (isYou) на фронте
 * всё равно подписывается как "Вы" независимо от этого флага.
 */
router.get('/', async (req, res) => {
    const period = req.query.period === 'week' ? 'week' : 'all';
    const telegramUser = req.telegramUser;

    const whereClause = period === 'week' ? `WHERE gr.created_at >= datetime('now', '-7 days')` : '';

    const rows = await db.all(`
        SELECT u.id AS user_id, u.telegram_id, u.first_name, u.photo_url, u.leaderboard_anonymous,
               SUM(gr.bet_coins) AS total_wagered
        FROM game_rounds gr
        JOIN users u ON u.id = gr.user_id
        ${whereClause}
        GROUP BY u.id
        ORDER BY total_wagered DESC
        LIMIT ?
    `, [LIMIT]);

    const leaders = rows.map((r, i) => {
        const anonymous = !!r.leaderboard_anonymous;
        return {
            rank: i + 1,
            firstName: anonymous ? 'Аноним' : (r.first_name || 'Игрок'),
            photoUrl: anonymous ? null : (r.photo_url || null),
            anonymous,
            totalWagered: Number(r.total_wagered) || 0,
            isYou: telegramUser?.id != null && Number(r.telegram_id) === Number(telegramUser.id),
        };
    });

    // Если текущий игрок не попал в топ-LIMIT, отдельно считаем его личное
    // место/сумму — чтобы можно было показать "твоя позиция" даже вне топа.
    let me = leaders.find((l) => l.isYou) || null;
    if (!me) {
        const user = await getOrCreateUser(telegramUser);
        const mine = await db.get(`
            SELECT COALESCE(SUM(bet_coins), 0) AS total_wagered
            FROM game_rounds gr
            WHERE gr.user_id = ? ${period === 'week' ? `AND gr.created_at >= datetime('now', '-7 days')` : ''}
        `, [user.id]);
        const totalWagered = Number(mine?.total_wagered) || 0;
        if (totalWagered > 0) {
            const better = await db.get(`
                SELECT COUNT(*) AS cnt FROM (
                    SELECT gr.user_id, SUM(gr.bet_coins) AS s
                    FROM game_rounds gr
                    ${whereClause}
                    GROUP BY gr.user_id
                    HAVING s > ?
                )
            `, [totalWagered]);
            me = {
                rank: (Number(better?.cnt) || 0) + 1,
                firstName: user.first_name || 'Игрок',
                photoUrl: user.photo_url || null,
                anonymous: !!user.leaderboard_anonymous,
                totalWagered,
                isYou: true,
                outsideTop: true,
            };
        }
    }

    res.json({ period, leaders, me });
});

module.exports = router;
