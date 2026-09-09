const crypto = require('crypto');

/**
 * Server-side взвешенный RNG.
 * ВАЖНО: вся генерация результата происходит только здесь, на сервере.
 * Клиент никогда не передаёт и не может повлиять на результат — он лишь
 * проигрывает анимацию, используя уже готовый itemId, присланный сервером.
 *
 * Результат выводится из заранее закоммиченного serverSeed. Поэтому после
 * раскрытия seed игрок может воспроизвести этот же выбор самостоятельно.
 */

/**
 * @param {Array<{id:number, weight:number}>} items - пул предметов кейса с весами
 * @returns {{ item: object, rollValue: number, serverSeed: string }}
 */
function rollWeightedItem(items, serverSeed) {
    if (!items || items.length === 0) {
        throw new Error('Пустой пул предметов для розыгрыша');
    }

    const totalWeight = items.reduce((sum, i) => sum + i.weight, 0);
    if (totalWeight <= 0) {
        throw new Error('Некорректная сумма весов (weight) в конфигурации кейса');
    }

    if (!serverSeed) throw new Error('Для provably-fair roll требуется serverSeed');
    const randomPoint = deterministicInt(serverSeed, 'case-weighted', 0, totalWeight);

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

function deterministicInt(serverSeed, domain, counter, max) {
    if (!Number.isInteger(max) || max <= 0 || max > 0x100000000) throw new Error('Некорректный диапазон RNG');
    // Rejection sampling keeps a weighted table unbiased even when max does
    // not divide 2^32; changing the counter makes a retry deterministic too.
    const limit = Math.floor(0x100000000 / max) * max;
    for (let attempt = 0; ; attempt++) {
        const digest = crypto.createHash('sha256').update(`${serverSeed}:${domain}:${counter}:${attempt}`).digest();
        const value = digest.readUInt32BE(0);
        if (value < limit) return value % max;
    }
}

module.exports = { rollWeightedItem, deterministicInt };
