/**
 * Тонкий клиент над REST API бэкенда.
 * Каждый запрос несёт X-Telegram-Init-Data — сервер сам валидирует подпись
 * и определяет пользователя. Клиент никогда не передаёт "готовые" результаты
 * розыгрышей/игр — только запрашивает действия, всё считает сервер.
 */
const API_BASE = '/api';

async function apiRequest(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const initData = TelegramBridge.getInitData();
  if (initData) headers['X-Telegram-Init-Data'] = initData;

  const user = TelegramBridge.getUser();
  if (user?.id) headers['X-Dev-Telegram-Id'] = String(user.id);

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка запроса (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

const Api = {
  getCases: () => apiRequest('/cases'),
  getCaseDetails: (slug) => apiRequest(`/cases/${slug}`),
  caseFairnessCommit: (slug) => apiRequest(`/cases/fairness/${encodeURIComponent(slug)}`),
  openCase: (slug, commitmentId) => apiRequest(`/cases/${slug}/open`, { method: 'POST', body: { commitmentId } }),

  getProfile: () => apiRequest('/user/me'),
  getTransactions: () => apiRequest('/user/transactions'),
  setLeaderboardVisibility: (anonymous) => apiRequest('/user/leaderboard-visibility', { method: 'POST', body: { anonymous } }),
  createPromo: (amount, maxUses) => apiRequest('/promos/create', { method: 'POST', body: { amount, maxUses } }),
  redeemPromo: (code) => apiRequest('/promos/redeem', { method: 'POST', body: { code } }),
  getMyPromos: () => apiRequest('/promos/mine'),
  cancelPromo: (promoId) => apiRequest('/promos/cancel', { method: 'POST', body: { promoId } }),
  createTopupInvoice: (amount) => apiRequest('/user/topup/invoice', { method: 'POST', body: { amount } }),
  getTopupStatus: (paymentId) => apiRequest(`/user/topup/status/${encodeURIComponent(paymentId)}`),

  // ---- Crash (общий раунд для всех игроков) ----
  crashState: () => apiRequest('/games/crash/state'),
  crashBet: (bet) => apiRequest('/games/crash/bet', { method: 'POST', body: { bet } }),
  crashCashout: (multiplier) => apiRequest('/games/crash/cashout', { method: 'POST', body: { multiplier } }),
  fairnessCommit: (gameType) => apiRequest(`/games/fairness/${encodeURIComponent(gameType)}`),

  // ---- Mines ----
  minesStart: (bet, mineCount, commitmentId) => apiRequest('/games/mines/start', { method: 'POST', body: { bet, mineCount, commitmentId } }),
  minesStatus: () => apiRequest('/games/mines/status'),
  minesReveal: (tile) => apiRequest('/games/mines/reveal', { method: 'POST', body: { tile } }),
  minesCashout: () => apiRequest('/games/mines/cashout', { method: 'POST' }),

  // ---- Plinko ----
  plinkoPlay: (bet, risk, commitmentId) => apiRequest('/games/plinko/play', { method: 'POST', body: { bet, risk, commitmentId } }),

  // ---- Towers ----
  towersStart: (bet, commitmentId) => apiRequest('/games/towers/start', { method: 'POST', body: { bet, commitmentId } }),
  towersStatus: () => apiRequest('/games/towers/status'),
  towersPick: (tile) => apiRequest('/games/towers/pick', { method: 'POST', body: { tile } }),
  towersCashout: () => apiRequest('/games/towers/cashout', { method: 'POST' }),

  // ---- Upgrade ----
  upgradePlay: (bet, chance, commitmentId) => apiRequest('/games/upgrade/play', { method: 'POST', body: { bet, chance, commitmentId } }),

  // ---- Wheel ----
  wheelPlay: (bet, commitmentId) => apiRequest('/games/wheel/play', { method: 'POST', body: { bet, commitmentId } }),

  // ---- Leaderboard ----
  getLeaderboard: (period) => apiRequest(`/leaderboard?period=${period === 'week' ? 'week' : 'all'}`),
};
