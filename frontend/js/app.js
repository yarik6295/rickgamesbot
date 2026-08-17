/**
 * Главный контроллер Mini App: навигация по табам, рендер кейсов,
 * инвентаря, профиля, и оркестрация открытия кейса.
 * Вся валюта в приложении — виртуальные звёзды (coins_balance),
 * не покупаются и не выводятся.
 */
const state = {
  cases: [],
  currentCase: null,
  profile: null,
  isSpinning: false,
  caseItemsCache: {}, // slug -> items[]; прогревается в фоне, см. prefetchCaseItems()
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// БАГ (исправлено): в WebKit на iOS (Safari, а также Telegram WebView внутри
// iOS-приложения — оба на WebKit) псевдокласс :active по тапу пальцем НЕ
// срабатывает вообще, если в document нет ни одного touch-обработчика —
// это давняя особенность движка. Из-за этого все .towers-tile:active,
// .mine-cell:active, .btn-primary:active и т.п. в style.css молча не
// применялись на таких устройствах: тап регистрировался (и запрос на
// сервер уходил сразу), но экран визуально не реагировал вообще ничего,
// пока не прилетал ответ сети (~0.3–0.7с) — ощущалось как "залипание"/
// заметная задержка перед нажатием, хотя на деле сама логика отрабатывала
// мгновенно. Пустой touchstart-хендлер на document — стандартный и
// безвредный способ заставить WebKit применять :active по тапу.
document.addEventListener('touchstart', () => {}, { passive: true });

function showToast(message, type = 'info') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast ${type === 'error' ? 'error' : ''}`;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 2600);
}

function rarityEmoji() {
  // Единая иконка для всех призов — звезда (награды это просто звёзды).
  return '⭐';
}

/* ============================= НАВИГАЦИЯ ============================= */

function switchTab(tabName) {
  $$('.tab-panel').forEach((p) => p.classList.add('hidden'));
  $$('.nav-btn').forEach((b) => b.classList.remove('active'));

  document.getElementById(`tab-${tabName}`).classList.remove('hidden');
  document.querySelector(`.nav-btn[data-tab="${tabName}"]`)?.classList.add('active');

  if (tabName === 'profile') loadProfile();
}
window.switchTab = switchTab;

$$('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

/* ============================= БАЛАНС ============================= */

function updateBalanceUI(balance) {
  $('#balance-value').textContent = balance;
  if (state.profile?.user) state.profile.user.coins_balance = balance;
}
window.updateBalanceUI = updateBalanceUI;

/* ============================= ХАБ ИГР ============================= */

$$('.game-tile').forEach((tile) => {
  tile.addEventListener('click', () => {
    const game = tile.dataset.game;
    switchTab(`game-${game}`);
    window.Games?.onOpen?.(game);
  });
});

$$('.btn-back-to-games').forEach((btn) => {
  btn.addEventListener('click', () => {
    window.Games?.onLeave?.();
    switchTab('games');
  });
});

/* ============================= ЭКРАН КЕЙСОВ ============================= */

async function loadCases() {
  try {
    const { cases } = await Api.getCases();
    state.cases = cases;
    renderCasesGrid();
    prefetchCaseItems();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// БАГ (исправлено): раньше содержимое кейса (items) запрашивалось у сервера
// ТОЛЬКО в момент открытия экрана кейса (внутри openCaseScreen), поэтому
// пользователь секунду видел пустой/чёрный барабан (фон .roulette-wrap
// тёмный, #0c0c16), пока летел запрос. Теперь сразу после загрузки списка
// кейсов в фоне прогреваем кэш содержимого всех кейсов — к моменту, когда
// пользователь реально тапнет по какому-то кейсу, данные обычно уже есть
// и превью отрисовывается мгновенно, без сетевой задержки.
function prefetchCaseItems() {
  state.cases.forEach((c) => {
    if (state.caseItemsCache[c.slug]) return;
    Api.getCaseDetails(c.slug)
      .then(({ items }) => { state.caseItemsCache[c.slug] = items; })
      .catch(() => {}); // не критично — просто не прогреется кэш для этого кейса
  });
}

function renderCasesGrid() {
  const grid = $('#cases-grid');
  grid.innerHTML = '';
  const userLevel = state.profile?.user?.account_level || 1;

  const caseIcons = ['🎁', '💎', '🔮', '👑', '🧨', '⭐'];

  state.cases.forEach((c, i) => {
    const locked = userLevel < c.min_level;
    const card = document.createElement('div');
    card.className = `case-row theme-${i % 5}`;

    let priceHtml = `<div class="case-price">⭐ ${c.price_coins}</div>`;
    let lockedOverlay = '';
    let clickable = !locked;

    if (c.isFree) {
      if (c.freeCaseAvailable) {
        priceHtml = `<div class="case-price">🎁 Бесплатно</div>`;
      } else {
        priceHtml = `<div class="case-price">🎁 Бесплатно</div>`;
        lockedOverlay = `<div class="case-locked"><span>⏳</span><span data-cooldown="${c.freeCaseNextAt}">--:--</span></div>`;
        clickable = false;
      }
    } else if (locked) {
      lockedOverlay = `<div class="case-locked"><span>🔒</span><span>Уровень ${c.min_level}</span></div>`;
    }

    card.innerHTML = `
      <div class="case-info">
        <div class="case-name">${c.name}</div>
        ${priceHtml}
      </div>
      <div class="case-icon">${caseIcons[i % caseIcons.length]}</div>
      ${lockedOverlay}
    `;
    if (clickable) {
      card.addEventListener('click', () => openCaseScreen(c));
    }
    grid.appendChild(card);
  });

  updateFreeCaseCountdowns();
}

let freeCaseCountdownTimer = null;
function updateFreeCaseCountdowns() {
  clearInterval(freeCaseCountdownTimer);
  const tick = () => {
    let anyPending = false;
    $$('[data-cooldown]').forEach((el) => {
      const nextAt = Number(el.dataset.cooldown);
      const remainingMs = nextAt - Date.now();
      if (remainingMs <= 0) {
        // Кулдаун истёк — перерисовываем список, чтобы кейс снова стал кликабельным
        loadCases();
        return;
      }
      anyPending = true;
      const h = Math.floor(remainingMs / 3600000);
      const m = Math.floor((remainingMs % 3600000) / 60000);
      el.textContent = `${h}ч ${m}м`;
    });
    if (!anyPending) clearInterval(freeCaseCountdownTimer);
  };
  tick();
  freeCaseCountdownTimer = setInterval(tick, 30000);
}

/* ============================= ЭКРАН РУЛЕТКИ ============================= */

async function openCaseScreen(caseObj) {
  state.currentCase = caseObj;
  $('#roulette-case-name').textContent = caseObj.name;
  $('#roulette-result').classList.add('hidden');
  $('#btn-open-case').disabled = false;
  $('#btn-open-case').textContent = caseObj.isFree ? 'Открыть бесплатно 🎁' : `Открыть за ${caseObj.price_coins} ⭐`;

  // Если содержимое кейса уже прогрето в фоне (см. prefetchCaseItems) —
  // показываем превью СРАЗУ, синхронно, без сетевой задержки.
  const cached = state.caseItemsCache[caseObj.slug];
  if (cached) {
    Roulette.preview(cached);
  } else {
    // Кэш ещё не прогрелся — вместо Roulette.reset() (пустая тёмная лента,
    // которая выглядела как "чёрный экран, пока грузится") показываем
    // мгновенный skeleton-плейсхолдер. Он рисуется синхронно, ДО любого
    // await, так что появляется одновременно с самим окном кейса, а не
    // с задержкой в неопределённое (зависящее от сети) время.
    Roulette.skeleton();
  }
  switchTab('roulette');

  if (cached) return;

  // Кэш ещё не прогрелся (например, самый первый визит в приложение) —
  // как и раньше, подгружаем превью отдельным запросом.
  try {
    const { items } = await Api.getCaseDetails(caseObj.slug);
    state.caseItemsCache[caseObj.slug] = items;
    // Пока запрос летел, пользователь мог уже уйти с этого кейса — не подменяем
    // ленту чужим превью.
    if (state.currentCase === caseObj) Roulette.preview(items);
  } catch (e) {
    // Превью не критично для открытия кейса — молча оставляем ленту пустой.
  }
}

$('#btn-back-to-cases').addEventListener('click', () => switchTab('cases'));

$('#btn-open-case').addEventListener('click', async () => {
  if (state.isSpinning || !state.currentCase) return;

  const openBtn = $('#btn-open-case');
  const isFree = !!state.currentCase.isFree;
  state.isSpinning = true;
  openBtn.disabled = true;
  openBtn.textContent = 'Открываем...';
  $('#roulette-result').classList.add('hidden');

  try {
    const result = await Api.openCase(state.currentCase.slug);

    TelegramBridge.haptic('light');

    await Roulette.play(result.reelPool, result.reward);

    TelegramBridge.haptic(result.reward.rarity === 'legendary' ? 'success' : 'medium');

    updateBalanceUI(result.newBalance);
    if (state.profile?.user) {
      state.profile.user.cases_opened = result.casesOpened;
      state.profile.user.account_level = result.accountLevel;
    }
    if (isFree) {
      state.currentCase.freeCaseAvailable = false;
      state.currentCase.freeCaseNextAt = result.freeCaseNextAt;
    }

    showResultCard(result.reward);
  } catch (e) {
    showToast(e.message, 'error');
    TelegramBridge.haptic('error');
  } finally {
    state.isSpinning = false;
    openBtn.disabled = false;
    openBtn.textContent = isFree ? 'Открыть бесплатно 🎁' : `Открыть за ${state.currentCase.price_coins} ⭐`;
  }
});

function showResultCard(reward) {
  const box = $('#result-item-display');
  box.innerHTML = `
    <div class="text-5xl mb-1">${rarityEmoji(reward.rarity)}</div>
    <div class="text-gold font-bold text-xl">⭐ ${reward.value_coins}</div>
  `;
  $('#roulette-result').classList.remove('hidden');
}

$('#btn-result-ok').addEventListener('click', () => {
  $('#roulette-result').classList.add('hidden');
  loadCases();
});

/* ============================= ПРОФИЛЬ ============================= */

async function loadProfile() {
  try {
    const { user, dailyBonus } = await Api.getProfile();
    state.profile = { user, dailyBonus };
    const tgUser = TelegramBridge.getUser();

    $('#profile-avatar').src = tgUser.photo_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=' + user.telegram_id;
    $('#profile-name').textContent = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'Игрок';
    $('#profile-username').textContent = tgUser.username ? '@' + tgUser.username : '';
    $('#profile-level').textContent = user.account_level;
    $('#profile-cases').textContent = user.cases_opened;
    $('#profile-balance').textContent = user.coins_balance;

    updateBalanceUI(user.coins_balance);
    updateDailyBonusButton();

    const { transactions } = await Api.getTransactions();
    renderTransactions(transactions);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

const TX_LABELS = {
  daily_bonus: '🎁 Ежедневный бонус',
  case_open: '🎁 Открытие кейса',
  sell_item: '💸 Продажа предмета',
  admin_adjust: '⚙️ Корректировка',
  game_bet: '🎮 Ставка в игре',
  game_win: '🏆 Выигрыш в игре',
  self_topup: '⭐ Пополнение баланса',
};

function renderTransactions(transactions) {
  const list = $('#tx-list');
  list.innerHTML = '';
  if (transactions.length === 0) {
    list.innerHTML = '<p class="text-white/30 text-xs text-center py-4">Транзакций пока нет</p>';
    return;
  }
  transactions.forEach((tx) => {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between bg-surface rounded-xl px-3 py-2 text-xs';
    const sign = tx.amount_coins >= 0 ? '+' : '';
    const color = tx.amount_coins >= 0 ? 'text-green-400' : 'text-red-400';
    row.innerHTML = `
      <span class="text-white/60">${TX_LABELS[tx.type] || tx.type}</span>
      <span class="${color} font-semibold">${sign}${tx.amount_coins} ⭐</span>
    `;
    list.appendChild(row);
  });
}

/* ============================= ЕЖЕДНЕВНЫЙ БОНУС ============================= */

function updateDailyBonusButton() {
  const btn = $('#btn-daily-bonus');
  const available = state.profile?.dailyBonus?.available;
  btn.classList.toggle('bonus-ready', !!available);
}

$('#btn-daily-bonus').addEventListener('click', () => {
  const available = state.profile?.dailyBonus?.available ?? true;
  $('#daily-bonus-text').textContent = available
    ? 'Заберите бесплатные звёзды — доступно раз в 24 часа.'
    : 'Бонус уже получен сегодня. Загляните завтра!';
  $('#btn-daily-bonus-claim').disabled = !available;
  $('#daily-bonus-modal').classList.remove('hidden');
});

$('#btn-daily-bonus-cancel').addEventListener('click', () => {
  $('#daily-bonus-modal').classList.add('hidden');
});

$('#btn-daily-bonus-claim').addEventListener('click', async () => {
  const claimBtn = $('#btn-daily-bonus-claim');
  claimBtn.disabled = true;
  try {
    const res = await Api.claimDailyBonus();
    updateBalanceUI(res.newBalance);
    showToast(`Начислено ${res.amount} ⭐!`);
    TelegramBridge.haptic('success');
    if (state.profile) state.profile.dailyBonus = { available: false };
    updateDailyBonusButton();
    $('#daily-bonus-modal').classList.add('hidden');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    claimBtn.disabled = false;
  }
});

/* ============================= ПОПОЛНЕНИЕ БАЛАНСА ============================= */

function openTopupModal() {
  const input = $('#topup-amount-input');
  input.value = '';
  $('#topup-modal').classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}

$('#btn-topup').addEventListener('click', openTopupModal);
$('#btn-topup-plus').addEventListener('click', openTopupModal);

$('#btn-topup-cancel').addEventListener('click', () => {
  $('#topup-modal').classList.add('hidden');
});

async function submitTopup() {
  const input = $('#topup-amount-input');
  const amount = Math.floor(Number(input.value));
  if (!Number.isFinite(amount) || amount <= 0) {
    showToast('Введите сумму больше нуля', 'error');
    return;
  }

  const confirmBtn = $('#btn-topup-confirm');
  confirmBtn.disabled = true;
  try {
    const res = await Api.topUp(amount);
    updateBalanceUI(res.newBalance);
    showToast(`Баланс пополнен на ${res.amount} ⭐`);
    TelegramBridge.haptic('success');
    $('#topup-modal').classList.add('hidden');
  } catch (e) {
    showToast(e.message, 'error');
    TelegramBridge.haptic('error');
  } finally {
    confirmBtn.disabled = false;
  }
}

$('#btn-topup-confirm').addEventListener('click', submitTopup);
$('#topup-amount-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitTopup();
});

/* ============================= ИНИЦИАЛИЗАЦИЯ ============================= */

async function init() {
  await loadProfile();
  await loadCases();
}

init();
