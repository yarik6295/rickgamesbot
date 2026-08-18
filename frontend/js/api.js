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
  openCase: (slug) => apiRequest(`/cases/${slug}/open`, { method: 'POST' }),

  getProfile: () => apiRequest('/user/me'),
  getTransactions: () => apiRequest('/user/transactions'),
  topUp: (amount) => apiRequest('/user/topup', { method: 'POST', body: { amount } }),

  // ---- Crash (общий раунд для всех игроков) ----
  crashState: () => apiRequest('/games/crash/state'),
  crashBet: (bet) => apiRequest('/games/crash/bet', { method: 'POST', body: { bet } }),
  crashCashout: (multiplier) => apiRequest('/games/crash/cashout', { method: 'POST', body: { multiplier } }),

  // ---- Mines ----
  minesStart: (bet, mineCount) => apiRequest('/games/mines/start', { method: 'POST', body: { bet, mineCount } }),
  minesStatus: () => apiRequest('/games/mines/status'),
  minesReveal: (tile) => apiRequest('/games/mines/reveal', { method: 'POST', body: { tile } }),
  minesCashout: () => apiRequest('/games/mines/cashout', { method: 'POST' }),

  // ---- Plinko ----
  plinkoPlay: (bet, risk) => apiRequest('/games/plinko/play', { method: 'POST', body: { bet, risk } }),

  // ---- Towers ----
  towersStart: (bet) => apiRequest('/games/towers/start', { method: 'POST', body: { bet } }),
  towersStatus: () => apiRequest('/games/towers/status'),
  towersPick: (tile) => apiRequest('/games/towers/pick', { method: 'POST', body: { tile } }),
  towersCashout: () => apiRequest('/games/towers/cashout', { method: 'POST' }),

  // ---- Upgrade ----
  upgradePlay: (bet, chance) => apiRequest('/games/upgrade/play', { method: 'POST', body: { bet, chance } }),

  // ---- Wheel ----
  wheelPlay: (bet) => apiRequest('/games/wheel/play', { method: 'POST', body: { bet } }),
};
