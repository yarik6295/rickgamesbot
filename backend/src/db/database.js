const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/database.sqlite');

// Убедимся, что папка data существует
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Применяем схему при старте (идемпотентно, все CREATE TABLE IF NOT EXISTS)
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// Миграция: у CREATE TABLE IF NOT EXISTS есть предел — если таблица transactions
// уже была создана по старой схеме (без типа 'self_topup' для ручного пополнения
// баланса), CHECK-ограничение само не обновится. Пересоздаём таблицу с сохранением
// данных, если обнаружили старую версию схемы.
function migrateTransactionsCheckIfNeeded() {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'`).get();
    if (row && row.sql && !row.sql.includes('self_topup')) {
        db.exec('BEGIN');
        try {
            db.exec('ALTER TABLE transactions RENAME TO transactions_old');
            db.exec(schema); // пересоздаст transactions уже с новым CHECK
            db.exec(`
                INSERT INTO transactions (id, user_id, type, amount_coins, balance_after, reference_id, created_at)
                SELECT id, user_id, type, amount_coins, balance_after, reference_id, created_at FROM transactions_old
            `);
            db.exec('DROP TABLE transactions_old');
            db.exec('COMMIT');
            console.log('[db] Таблица transactions мигрирована: добавлен тип self_topup');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }
}
migrateTransactionsCheckIfNeeded();

// Миграция: раньше inventory.case_item_id и case_open_logs.result_item_id были
// NOT NULL REFERENCES case_items(id) без ON DELETE SET NULL. Из-за этого
// пересид кейсов (обновление пула призов) падал с FOREIGN KEY constraint failed,
// как только у кого-то уже был выигранный предмет из старого пула. Пересоздаём
// обе таблицы с мягкой связью (ON DELETE SET NULL), сохраняя все данные.
function migrateNullableCaseItemRefsIfNeeded() {
    const invRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='inventory'`).get();
    if (invRow && invRow.sql && !invRow.sql.includes('SET NULL')) {
        db.exec('BEGIN');
        try {
            db.exec('ALTER TABLE inventory RENAME TO inventory_old');
            db.exec(schema); // пересоздаст inventory с nullable FK
            db.exec(`
                INSERT INTO inventory (id, user_id, case_item_id, name, value_coins, rarity, icon_url, status, obtained_at, resolved_at)
                SELECT id, user_id, case_item_id, name, value_coins, rarity, icon_url, status, obtained_at, resolved_at FROM inventory_old
            `);
            db.exec('DROP TABLE inventory_old');
            db.exec('COMMIT');
            console.log('[db] Таблица inventory мигрирована: case_item_id теперь nullable (ON DELETE SET NULL)');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }

    const logsRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='case_open_logs'`).get();
    if (logsRow && logsRow.sql && !logsRow.sql.includes('SET NULL')) {
        db.exec('BEGIN');
        try {
            db.exec('ALTER TABLE case_open_logs RENAME TO case_open_logs_old');
            db.exec(schema); // пересоздаст case_open_logs с nullable FK
            db.exec(`
                INSERT INTO case_open_logs (id, user_id, case_id, result_item_id, server_seed, roll_value, created_at)
                SELECT id, user_id, case_id, result_item_id, server_seed, roll_value, created_at FROM case_open_logs_old
            `);
            db.exec('DROP TABLE case_open_logs_old');
            db.exec('COMMIT');
            console.log('[db] Таблица case_open_logs мигрирована: result_item_id теперь nullable (ON DELETE SET NULL)');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }
}
migrateNullableCaseItemRefsIfNeeded();

// Миграция: добавляем users.last_free_case_at для существующих баз, созданных
// до появления бесплатного кейса (раз в 24 часа). ADD COLUMN безопасен и не
// требует пересоздания таблицы/FK.
function migrateFreeCaseColumnIfNeeded() {
    const cols = db.prepare(`PRAGMA table_info(users)`).all();
    const hasColumn = cols.some((c) => c.name === 'last_free_case_at');
    if (!hasColumn) {
        db.exec(`ALTER TABLE users ADD COLUMN last_free_case_at DATETIME`);
        console.log('[db] Таблица users мигрирована: добавлена колонка last_free_case_at');
    }
}
migrateFreeCaseColumnIfNeeded();

// Миграция: раньше case_items хранил "подарки" (name/icon_url) для инвентаря.
// Теперь награда кейса — это просто звёзды, инвентарь убран целиком. Если
// у кого-то уже поднята база со старой схемой (name NOT NULL), пересоздаём
// case_items под новую схему, перенося только value_coins/rarity/weight.
// Заодно дропаем саму таблицу inventory, если она осталась от старой версии.
function migrateGiftsRemovedIfNeeded() {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='case_items'`).get();
    if (row && row.sql && row.sql.includes('name')) {
        db.exec('BEGIN');
        try {
            db.exec('ALTER TABLE case_items RENAME TO case_items_old');
            db.exec(schema); // пересоздаст case_items уже без name/icon_url
            db.exec(`
                INSERT INTO case_items (id, case_id, value_coins, rarity, weight, created_at)
                SELECT id, case_id, value_coins, rarity, weight, created_at FROM case_items_old
            `);
            db.exec('DROP TABLE case_items_old');
            db.exec('DROP TABLE IF EXISTS inventory');
            db.exec('COMMIT');
            console.log('[db] Таблица case_items мигрирована: убраны "подарки" (name/icon_url), инвентарь удалён');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    } else {
        db.exec('DROP TABLE IF EXISTS inventory');
    }
}
migrateGiftsRemovedIfNeeded();

module.exports = db;
