const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
require('dotenv').config();

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
    throw new Error(
        'TURSO_DATABASE_URL не задан. Создай базу на turso.tech и укажи ' +
        'TURSO_DATABASE_URL и TURSO_AUTH_TOKEN в переменных окружения.'
    );
}

const client = createClient({ url, authToken });

/**
 * Тонкие обёртки над клиентом Turso (@libsql/client), которые повторяют
 * интерфейс, похожий на better-sqlite3 (get/all/run), но асинхронно —
 * потому что Turso работает по сети (даже с локальной embedded-репликой
 * протокол всё равно асинхронный).
 */
async function get(sql, params = []) {
    const res = await client.execute({ sql, args: params });
    return res.rows[0] || undefined;
}

async function all(sql, params = []) {
    const res = await client.execute({ sql, args: params });
    return res.rows;
}

async function run(sql, params = []) {
    const res = await client.execute({ sql, args: params });
    return { lastInsertRowid: res.lastInsertRowid, changes: res.rowsAffected };
}

/**
 * Асинхронная транзакция. Коллбек получает объект с тем же интерфейсом
 * (get/all/run), но выполняющий запросы внутри одной атомарной транзакции.
 * Пример: await db.transaction(async (tx) => { await tx.run(...); ... });
 */
async function transaction(fn) {
    const tx = await client.transaction('write');
    const txDb = {
        get: async (sql, params = []) => {
            const res = await tx.execute({ sql, args: params });
            return res.rows[0] || undefined;
        },
        all: async (sql, params = []) => {
            const res = await tx.execute({ sql, args: params });
            return res.rows;
        },
        run: async (sql, params = []) => {
            const res = await tx.execute({ sql, args: params });
            return { lastInsertRowid: res.lastInsertRowid, changes: res.rowsAffected };
        },
    };
    try {
        const result = await fn(txDb);
        await tx.commit();
        return result;
    } catch (err) {
        await tx.rollback();
        throw err;
    }
}

/**
 * Применяет схему при старте. Раньше здесь были ещё и ALTER-миграции для
 * баз, созданных до определённых изменений схемы (self_topup, nullable FK,
 * last_free_case_at, удаление "подарков"). При переезде на Turso база
 * создаётся с нуля, поэтому все эти миграции не нужны — CREATE TABLE
 * IF NOT EXISTS в schema.sql сразу создаёт актуальную схему.
 *
 * Исключение — leaderboard_anonymous: это ALTER на уже существующую
 * таблицу users, CREATE TABLE IF NOT EXISTS его не добавит на базах,
 * созданных до этого поля. Оборачиваем в try/catch — на свежих базах
 * колонка уже есть из schema.sql, и ALTER просто упадёт с "duplicate
 * column", что нормально и безопасно игнорировать.
 */
async function init() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    await client.executeMultiple(schema);
    try {
        await client.execute(`ALTER TABLE users ADD COLUMN leaderboard_anonymous INTEGER NOT NULL DEFAULT 1`);
    } catch (err) {
        // Колонка уже существует — ожидаемо на новых базах и при повторном запуске.
    }
}

module.exports = { get, all, run, transaction, init };
