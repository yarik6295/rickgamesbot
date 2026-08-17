-- =========================================================
-- Gifts Case Simulator — схема базы данных (SQLite)
-- ВАЖНО: coins_balance — ПОЛНОСТЬЮ ВИРТУАЛЬНАЯ валюта.
-- Её нельзя купить за реальные деньги и нельзя вывести.
-- Пополняется только через игровые механики (ежедневный бонус,
-- достижения, рефералы) — см. userRoutes/dailyBonus.
-- =========================================================

-- Пользователи (привязаны к Telegram ID)
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id     INTEGER UNIQUE NOT NULL,
    username        TEXT,
    first_name      TEXT,
    photo_url       TEXT,
    coins_balance   INTEGER NOT NULL DEFAULT 500,     -- виртуальный баланс (стартовый бонус)
    account_level   INTEGER NOT NULL DEFAULT 1,
    cases_opened    INTEGER NOT NULL DEFAULT 0,
    xp              INTEGER NOT NULL DEFAULT 0,
    last_daily_bonus_at DATETIME,                     -- когда последний раз забирал ежедневный бонус
    last_free_case_at DATETIME,                       -- когда последний раз открывал бесплатный кейс (раз в 24ч)
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Конфигурация кейсов
CREATE TABLE IF NOT EXISTS cases (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    slug            TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    price_coins     INTEGER NOT NULL,
    icon_url        TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    min_level       INTEGER NOT NULL DEFAULT 1,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Пул наград внутри кейса (Drop Table) — чисто денежные призы в звёздах,
-- никаких "подарков"/коллекционных предметов: выигрыш сразу зачисляется
-- на баланс пользователя.
CREATE TABLE IF NOT EXISTS case_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id         INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    value_coins     INTEGER NOT NULL,                 -- сколько звёзд начисляется при выигрыше этого тира
    rarity          TEXT NOT NULL CHECK(rarity IN ('common','uncommon','rare','epic','legendary')),
    weight          INTEGER NOT NULL,                 -- шанс = weight / SUM(weight) по кейсу
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Транзакции виртуального баланса
CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            TEXT NOT NULL CHECK(type IN (
                        'daily_bonus','case_open','sell_item','admin_adjust',
                        'game_bet','game_win','self_topup'
                    )),
    amount_coins    INTEGER NOT NULL,                 -- +начисление / -списание
    balance_after   INTEGER NOT NULL,
    reference_id    INTEGER,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Лог открытий кейсов (аудит RNG, provably-fair)
CREATE TABLE IF NOT EXISTS case_open_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    case_id         INTEGER NOT NULL REFERENCES cases(id),
    -- Какой тир награды выпал — может стать NULL после пересида кейса.
    result_item_id  INTEGER REFERENCES case_items(id) ON DELETE SET NULL,
    server_seed     TEXT NOT NULL,
    roll_value      REAL NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Лог игровых раундов (Crash / Mines / Plinko / Towers) — тоже provably-fair аудит
CREATE TABLE IF NOT EXISTS game_rounds (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    game_type       TEXT NOT NULL CHECK(game_type IN ('crash','mines','plinko','towers','upgrade','wheel')),
    bet_coins       INTEGER NOT NULL,
    payout_coins    INTEGER NOT NULL DEFAULT 0,
    multiplier      REAL,
    outcome         TEXT NOT NULL CHECK(outcome IN ('win','lose','cashout')),
    round_data      TEXT,                              -- JSON: детали раунда (мины, точки plinko, этажи towers и т.д.)
    server_seed     TEXT NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Активные (незавершённые) раунды Mines/Towers — сервер хранит скрытое состояние
-- (позиции мин/бомб) между запросами, клиент никогда его не видит до конца раунда.
CREATE TABLE IF NOT EXISTS active_rounds (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_type       TEXT NOT NULL CHECK(game_type IN ('mines','towers')),
    bet_coins       INTEGER NOT NULL,
    config          TEXT NOT NULL,                     -- JSON: grid size / mine count / rows etc.
    hidden_state    TEXT NOT NULL,                      -- JSON: реальные позиции мин/бомб (не отдаётся клиенту)
    revealed        TEXT NOT NULL DEFAULT '[]',          -- JSON: что уже открыто
    server_seed     TEXT NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, game_type)
);

CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_case_items_case ON case_items(case_id);
CREATE INDEX IF NOT EXISTS idx_game_rounds_user ON game_rounds(user_id);
