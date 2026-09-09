const crypto = require('crypto');

// A commitment is created before the player starts a round.  Keeping the
// unrevealed seed only on the server prevents the client from predicting the
// result, while its SHA-256 hash makes replacing that seed afterwards visible.
const commitments = new Map();
const COMMITMENT_TTL_MS = 10 * 60 * 1000;

function hashServerSeed(serverSeed) {
    return crypto.createHash('sha256').update(serverSeed, 'utf8').digest('hex');
}

function createCommitment(userId, gameType) {
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const commitmentId = crypto.randomUUID();
    commitments.set(commitmentId, { userId, gameType, serverSeed, expiresAt: Date.now() + COMMITMENT_TTL_MS });
    return { commitmentId, serverSeedHash: hashServerSeed(serverSeed) };
}

function consumeCommitment(userId, gameType, commitmentId) {
    const commitment = commitments.get(commitmentId);
    if (!commitment || commitment.userId !== userId || commitment.gameType !== gameType || commitment.expiresAt < Date.now()) {
        throw { status: 409, message: 'Проверочный hash устарел. Получите новый перед началом раунда.' };
    }
    commitments.delete(commitmentId); // A seed is single-use, including failed attempts.
    return { serverSeed: commitment.serverSeed, serverSeedHash: hashServerSeed(commitment.serverSeed) };
}

function publicFairness(serverSeed) {
    return { serverSeed, serverSeedHash: hashServerSeed(serverSeed), algorithm: 'sha256(seed:domain:counter)' };
}

module.exports = { hashServerSeed, createCommitment, consumeCommitment, publicFairness };
