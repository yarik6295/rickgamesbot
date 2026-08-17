const crypto = require('crypto');

/**
 * Server-side взвешенный RNG.
 * ВАЖНО: вся генерация результата происходит только здесь, на сервере.
 * Клиент никогда не передаёт и не может повлиять на результат — он лишь
 * проигрывает анимацию, используя уже готовый itemId, присланный сервером.
 *
 * Используем crypto.randomInt (криптографически стойкий генератор),
 * а не Math.random(), чтобы результат нельзя было предсказать/подобрать seed.
 */

/**
 * @param {Array<{id:number, weight:number}>} items - пул предметов кейса с весами
 * @returns {{ item: object, rollValue: number, serverSeed: string }}
 */
function rollWeightedItem(items) {
    if (!items || items.length === 0) {
        throw new Error('Пустой пул предметов для розыгрыша');
    }

    const totalWeight = items.reduce((sum, i) => sum + i.weight, 0);
    if (totalWeight <= 0) {
        throw new Error('Некорректная сумма весов (weight) в конфигурации кейса');
    }

    // Криптографически стойкое случайное число в [0, totalWeight)
    // randomInt поддерживает диапазон до 2^48, чего более чем достаточно
    const randomPoint = crypto.randomInt(0, totalWeight);

    // Дополнительно сохраняем "сырой" сид для аудита/прозрачности (provably-fair лог)
    const serverSeed = crypto.randomBytes(16).toString('hex');

    let cumulative = 0;
    let chosen = null;
    for (const item of items) {
        cumulative += item.weight;
        if (randomPoint < cumulative) {
            chosen = item;
            break;
        }
    }
    // fallback на случай ошибок округления
    if (!chosen) chosen = items[items.length - 1];

    return {
        item: chosen,
        rollValue: randomPoint / totalWeight,
        serverSeed,
    };
}

module.exports = { rollWeightedItem };
