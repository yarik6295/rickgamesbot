require('dotenv').config();
const db = require('../db/database');
const { getOrCreateUser } = require('../services/userService');
const { callBotApi } = require('../services/telegramApi');
const { createPromoCode, redeemPromoCode, cancelPromoCode, getMyPromos } = require('../services/promoService');

// URL Mini App (то, что задано в @BotFather → Bot Settings → Menu Button / Web App).
// Без него кнопка "Открыть Mini App" просто не показывается, чтобы не отправлять
// невалидную web_app-кнопку в Telegram.
const WEBAPP_URL = process.env.WEBAPP_URL || '';

// =========================================================
// Клавиатуры
// =========================================================

// Подписи кнопок нижней (reply) клавиатуры — всегда видна под полем ввода.
const KB_PROFILE = '👤 Профиль';
const KB_PLAY = '⭐ Играть';
const KB_CHECKS = '🎟 Чеки';
const KB_ABOUT = 'ℹ️ О проекте';

// Постоянная клавиатура из кнопок под полем ввода.
// "Играть" пока неактивна — раздел с играми в разработке.
function replyKeyboard() {
    return {
        keyboard: [
            [{ text: KB_PROFILE }, { text: KB_PLAY }],
            [{ text: KB_CHECKS }, { text: KB_ABOUT }],
        ],
        resize_keyboard: true,
        is_persistent: true,
    };
}

function mainMenuKeyboard() {
    const rows = [];
    if (WEBAPP_URL) {
        rows.push([{ text: '🎮 Открыть Mini App', web_app: { url: WEBAPP_URL } }]);
    }
    rows.push([
        { text: '👤 Профиль', callback_data: 'menu:profile' },
        { text: '🎟 Чеки', callback_data: 'menu:promos' },
    ]);
    rows.push([{ text: '⭐ Играть', callback_data: 'menu:play' }]);
    return { inline_keyboard: rows };
}

function backKeyboard() {
    const rows = [];
    if (WEBAPP_URL) {
        rows.push([{ text: '🎮 Открыть Mini App', web_app: { url: WEBAPP_URL } }]);
    }
    rows.push([{ text: '⬅️ Назад в меню', callback_data: 'menu:home' }]);
    return { inline_keyboard: rows };
}

// Клавиатура раздела «Профиль»: история и топ игроков теперь живут здесь.
function profileKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: '📜 История', callback_data: 'menu:history' },
                { text: '🏆 Топ игроков', callback_data: 'menu:leaderboard' },
            ],
            [{ text: '⬅️ Назад в меню', callback_data: 'menu:home' }],
        ],
    };
}

// Клавиатура для подразделов профиля (история / топ игроков) — ведёт назад в профиль.
function backToProfileKeyboard() {
    return {
        inline_keyboard: [[{ text: '⬅️ Назад в профиль', callback_data: 'menu:profile' }]],
    };
}

// =========================================================
// Тексты разделов
// =========================================================

function welcomeText(firstName) {
    const name = firstName ? `, ${firstName}` : '';
    return [
        `👋 Привет${name}!`,
        '',
        '*Rick Games* — мини-игры и виртуальный баланс.',
        '',
        'Профиль, история операций и топ игроков теперь во вкладке «Профиль».',
        'Для самих игр используй Mini App.',
        '',
        'Меню всегда доступно кнопками ниже 👇',
    ].join('\n');
}

async function profileText(telegramUser) {
    const user = await getOrCreateUser(telegramUser);
    return [
        '👤 *Профиль*',
        '',
        `Имя: ${user.first_name || 'Игрок'}`,
        `Уровень аккаунта: ${user.account_level}`,
        `Баланс: ${user.coins_balance} ⭐`,
    ].join('\n');
}


async function promoMenuData(telegramUser) {
    const promos = await getMyPromos(telegramUser);
    const lines = [
        '🎟 *Чеки*',
        '',
        'Создавай чек со своего баланса и отправляй код другу.',
        'Или активируй чек, который прислал тебе другой игрок.',
        '',
        'При создании сумма резервируется из твоего баланса.',
    ];

    if (promos.length) {
        lines.push('', '*Твои чеки:*');
        promos.slice(0, 10).forEach((p) => {
            const remaining = Math.max(0, Number(p.max_uses) - Number(p.used_uses));
            const state = p.status === 'active'
                ? `активен, осталось ${remaining}`
                : p.status === 'exhausted'
                    ? 'полностью использован'
                    : 'деактивирован';
            lines.push(`• \`${p.code}\` — ${p.amount_coins} ⭐ × ${p.max_uses} (${state})`);
        });
    } else {
        lines.push('', 'Твоих созданных чеков пока нет.');
    }

    const keyboard = [
        [
            { text: '🎟 Активировать', callback_data: 'promo:redeem' },
            { text: '➕ Создать', callback_data: 'promo:create' },
        ],
    ];

    promos.filter((p) => p.status === 'active').slice(0, 10).forEach((p) => {
        keyboard.push([{ text: `❌ Деактивировать ${p.code}`, callback_data: `promo:cancel:${p.id}` }]);
    });

    keyboard.push([{ text: '⬅️ Назад в меню', callback_data: 'menu:home' }]);
    return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

async function promoMenuText(telegramUser) {
    return (await promoMenuData(telegramUser)).text;
}

async function promoMenuKeyboard(telegramUser) {
    return (await promoMenuData(telegramUser)).keyboard;
}

const promoFlow = new Map();

async function handlePromoMessage(message) {
    const chatId = message.chat.id;
    const text = (message.text || '').trim();
    const flow = promoFlow.get(chatId);
    if (!flow) return false;

    try {
        if (flow.action === 'redeem') {
            const result = await redeemPromoCode(message.from, text);
            promoFlow.delete(chatId);
            const promoMenu = await promoMenuData(message.from);
            await sendMessage(chatId,
                `✅ *Чек активирован!*\n\nНачислено: +${result.amount} ⭐\nНовый баланс: ${result.newBalance} ⭐`,
                promoMenu.keyboard);
            return true;
        }
        if (flow.action === 'create' && flow.step === 'amount') {
            const amount = Math.floor(Number(text));
            if (!Number.isInteger(amount) || amount <= 0) {
                await sendMessage(chatId, '❌ Введи положительное целое число — сумму за одно использование.');
                return true;
            }
            flow.amount = amount;
            flow.step = 'uses';
            await sendMessage(chatId, 'Сколько раз можно использовать код? (от 1 до 1000)');
            return true;
        }
        if (flow.action === 'create' && flow.step === 'uses') {
            const maxUses = Math.floor(Number(text));
            if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
                await sendMessage(chatId, '❌ Введи число от 1 до 1000.');
                return true;
            }
            const result = await createPromoCode(message.from, flow.amount, maxUses);
            promoFlow.delete(chatId);
            await sendMessage(chatId,
                `✅ *Чек создан!*\\n\\nКод: \`${result.code}\`\\nСумма за использование: ${result.amount} ⭐\\nИспользований: ${result.maxUses}\\nЗарезервировано: ${result.reserved} ⭐\\n\\nОтправь этот код другу.`,
                mainMenuKeyboard());
            return true;
        }
    } catch (err) {
        promoFlow.delete(chatId);
        await sendMessage(chatId, `❌ ${err.message}`);
        return true;
    }
    return false;
}

const TX_TYPE_LABELS = {
    daily_bonus: 'Ежедневный бонус',
    case_open: 'Открытие кейса',
    sell_item: 'Продажа предмета',
    admin_adjust: 'Корректировка',
    game_bet: 'Ставка в игре',
    game_win: 'Выигрыш в игре',
    self_topup: 'Пополнение',
    stars_topup: 'Пополнение Stars',
};

async function historyText(telegramUser) {
    const user = await getOrCreateUser(telegramUser);
    const rows = await db.all(`
        SELECT type, amount_coins, balance_after, created_at
        FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10
    `, [user.id]);
    if (!rows.length) return '📜 *История операций*\n\nПока нет ни одной операции.';
    const lines = rows.map((t) => {
        const sign = t.amount_coins >= 0 ? '+' : '';
        const label = TX_TYPE_LABELS[t.type] || t.type;
        return `${label}: ${sign}${t.amount_coins} ⭐ (баланс: ${t.balance_after})`;
    });
    return ['📜 *Последние операции*', '', ...lines].join('\n');
}

async function leaderboardText() {
    const rows = await db.all(`
        SELECT u.first_name, SUM(gr.bet_coins) AS total_wagered
        FROM game_rounds gr
        JOIN users u ON u.id = gr.user_id
        GROUP BY u.id
        ORDER BY total_wagered DESC
        LIMIT 10
    `);
    if (!rows.length) return '🏆 *Топ игроков*\n\nПока никто не сделал ни одной ставки.';
    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, i) => {
        const marker = medals[i] || `${i + 1}.`;
        return `${marker} ${r.first_name || 'Игрок'} — ${Number(r.total_wagered)} ⭐`;
    });
    return ['🏆 *Топ игроков по объёму ставок*', '', ...lines].join('\n');
}

const ABOUT_TEXT = [
    'ℹ️ *О проекте*',
    '',
    'Rick Games — демонстрационный проект с мини-играми и виртуальным балансом.',
    'Вся генерация случайных',
    'результатов происходит на сервере (provably-fair подход).',
    '',
    'Баланс — демо-монеты: они не выводятся ни в деньги, ни в подарки.',
].join('\n');

// =========================================================
// Отправка/редактирование сообщений
// =========================================================

async function sendMessage(chatId, text, keyboard) {
    return callBotApi('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
    });
}

async function editMessage(chatId, messageId, text, keyboard) {
    try {
        return await callBotApi('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        });
    } catch (err) {
        // Например, "message is not modified" при повторном клике на тот же
        // раздел — не критично, просто логируем и продолжаем.
        console.warn('[bot] editMessageText failed:', err.message);
    }
}

// =========================================================
// Обработчики апдейтов
// =========================================================

// Отправляет приветствие + инлайн-кнопку Mini App, затем отдельным сообщением
// «включает» постоянную reply-клавиатуру снизу (Telegram не позволяет совмещать
// inline_keyboard и обычную keyboard в одном сообщении).
async function sendMainMenu(chatId, firstName) {
    await sendMessage(chatId, welcomeText(firstName), mainMenuKeyboard());
    await sendMessage(chatId, 'Быстрый доступ 👇', replyKeyboard());
}

async function sendProfile(chatId, telegramUser) {
    await sendMessage(chatId, await profileText(telegramUser), profileKeyboard());
}

async function sendChecks(chatId, telegramUser) {
    const promoMenu = await promoMenuData(telegramUser);
    await sendMessage(chatId, promoMenu.text, promoMenu.keyboard);
}

async function sendAbout(chatId) {
    await sendMessage(chatId, ABOUT_TEXT, backKeyboard());
}

const PLAY_TEXT = [
    `${KB_PLAY}`,
    '',
    'Раздел временно недоступен — мы его дорабатываем.',
    'Пока что все игры доступны через Mini App.',
].join('\n');

async function sendPlayPlaceholder(chatId) {
    await sendMessage(chatId, PLAY_TEXT, backKeyboard());
}

async function handleMessage(message) {
    const chatId = message.chat.id;
    const text = (message.text || '').trim();

    if (await handlePromoMessage(message)) return;

    if (text === '/start' || text.startsWith('/start ')) {
        await sendMainMenu(chatId, message.from?.first_name);
        return;
    }

    if (text === '/menu') {
        await sendMainMenu(chatId, message.from?.first_name);
        return;
    }

    if (text === '/checks' || text === '/promo') {
        await sendChecks(chatId, message.from);
        return;
    }

    // Кнопки постоянной клавиатуры снизу.
    if (text === KB_PROFILE) {
        await sendProfile(chatId, message.from);
        return;
    }
    if (text === KB_PLAY) {
        await sendPlayPlaceholder(chatId);
        return;
    }
    if (text === KB_CHECKS) {
        await sendChecks(chatId, message.from);
        return;
    }
    if (text === KB_ABOUT) {
        await sendAbout(chatId);
        return;
    }
}

async function handleCallbackQuery(callbackQuery) {
    const chatId = callbackQuery.message?.chat?.id;
    const messageId = callbackQuery.message?.message_id;
    const data = callbackQuery.data || '';
    const telegramUser = callbackQuery.from;

    if (!chatId || !messageId) {
        await callBotApi('answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(() => {});
        return;
    }

    try {
        if (data === 'promo:cancel:' || data.startsWith('promo:cancel:')) {
            const promoId = Number(data.slice('promo:cancel:'.length));
            const result = await cancelPromoCode(telegramUser, promoId);
            const promoMenu = await promoMenuData(telegramUser);
            await editMessage(chatId, messageId, promoMenu.text, promoMenu.keyboard);
            await callBotApi('answerCallbackQuery', {
                callback_query_id: callbackQuery.id,
                text: `Возвращено ${result.refund} ⭐`,
            });
            return;
        }

        if (data === 'promo:redeem') {
            promoFlow.set(chatId, { action: 'redeem' });
            await editMessage(chatId, messageId,
                '🎟 *Активировать чек*\n\nОтправь код чека следующим сообщением.',
                backKeyboard());
            await callBotApi('answerCallbackQuery', { callback_query_id: callbackQuery.id });
            return;
        }

        if (data === 'promo:create') {
            promoFlow.set(chatId, { action: 'create', step: 'amount' });
            await editMessage(chatId, messageId,
                '➕ *Создать чек*\n\nНапиши сумму ⭐ за одно использование.',
                backKeyboard());
            await callBotApi('answerCallbackQuery', { callback_query_id: callbackQuery.id });
            return;
        }

        if (data === 'menu:home' || !data.startsWith('menu:')) {
            await editMessage(chatId, messageId, welcomeText(telegramUser?.first_name), mainMenuKeyboard());
            await callBotApi('answerCallbackQuery', { callback_query_id: callbackQuery.id });
            return;
        }

        let text;
        switch (data) {
            case 'menu:profile':
                text = await profileText(telegramUser);
                break;
            case 'menu:promos':
                {
                    const promoMenu = await promoMenuData(telegramUser);
                    text = promoMenu.text;
                    break;
                }
            case 'menu:history':
                text = await historyText(telegramUser);
                break;
            case 'menu:leaderboard':
                text = await leaderboardText();
                break;
            case 'menu:about':
                text = ABOUT_TEXT;
                break;
            case 'menu:play':
                text = PLAY_TEXT;
                break;
            default:
                text = welcomeText(telegramUser?.first_name);
        }

        let keyboard;
        if (data === 'menu:promos') {
            keyboard = (await promoMenuData(telegramUser)).keyboard;
        } else if (data === 'menu:profile') {
            keyboard = profileKeyboard();
        } else if (data === 'menu:history' || data === 'menu:leaderboard') {
            keyboard = backToProfileKeyboard();
        } else {
            keyboard = backKeyboard();
        }
        await editMessage(chatId, messageId, text, keyboard);
        await callBotApi('answerCallbackQuery', { callback_query_id: callbackQuery.id });
    } catch (err) {
        console.error('[bot] callback_query error:', err);
        await callBotApi('answerCallbackQuery', {
            callback_query_id: callbackQuery.id,
            text: 'Что-то пошло не так, попробуйте ещё раз.',
        }).catch(() => {});
    }
}

/**
 * Единая точка входа для апдейтов из вебхука. Платёжные апдейты
 * (pre_checkout_query / successful_payment) сюда не относятся —
 * их обрабатывает payments.routes.js.
 */
async function handleUpdate(update) {
    if (update.message && !update.message.successful_payment) {
        await handleMessage(update.message);
    } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query);
    }
}

async function setBotCommands() {
    await callBotApi('setMyCommands', {
        commands: [
            { command: 'start', description: 'Запустить Rick Games' },
            { command: 'menu', description: 'Открыть меню' },
            { command: 'checks', description: 'Чеки' },
            { command: 'promo', description: 'Чеки (алиас)' },
        ],
    });
}

module.exports = { handleUpdate, setBotCommands };
