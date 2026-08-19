/**
 * Главный контроллер Mini App: навигация по табам, рендер кейсов,
 * инвентаря, профиля, и оркестрация открытия кейса.
 * coins_balance — внутренний игровой баланс. Пополнение этого баланса
 * происходит только после подтверждённой оплаты Telegram Stars.
 */
const state = {
  cases: [],
  currentCase: null,
  profile: null,
  isSpinning: false,
  caseItemsCache: {}, // slug -> items[]; прогревается в фоне, см. prefetchCaseItems()
  leadersPeriod: 'all',
  leadersLoadedFor: null, // какой период уже загружен, чтобы не дёргать API повторно без нужды
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
  if (tabName === 'leaders') loadLeaders();
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
      <div class="case-icon-wrap"><span class="case-icon">${caseIcons[i % caseIcons.length]}</span></div>
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

// Показывает пул возможных призов кейса под кнопкой "Открыть" — НАМЕРЕННО
// без указания шансов/весов (только сами значения), чтобы не превращать
// экран в таблицу вероятностей.
function renderPrizesList(items) {
  const grid = $('#case-prizes-grid');
  grid.innerHTML = '';
  const sorted = [...items].sort((a, b) => a.value_coins - b.value_coins);
  sorted.forEach((item) => {
    const chip = document.createElement('div');
    chip.className = `case-prize-chip rarity-${item.rarity}`;
    chip.innerHTML = `<span class="prize-star">⭐</span>${item.value_coins}`;
    grid.appendChild(chip);
  });
}

async function openCaseScreen(caseObj) {
  state.currentCase = caseObj;
  $('#roulette-case-name').textContent = caseObj.name;
  $('#roulette-result').classList.add('hidden');
  $('#btn-open-case').disabled = false;
  $('#btn-open-case').textContent = caseObj.isFree ? 'Открыть бесплатно 🎁' : `Открыть за ${caseObj.price_coins} ⭐`;
  $('#case-prizes-grid').innerHTML = '';

  // Если содержимое кейса уже прогрето в фоне (см. prefetchCaseItems) —
  // показываем превью СРАЗУ, синхронно, без сетевой задержки.
  const cached = state.caseItemsCache[caseObj.slug];
  if (cached) {
    Roulette.preview(cached);
    renderPrizesList(cached);
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
    if (state.currentCase === caseObj) {
      Roulette.preview(items);
      renderPrizesList(items);
    }
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

    // БАГ (исправлено): раньше баланс на экране обновлялся только ПОСЛЕ
    // Roulette.play() — то есть визуально казалось, что звёзды списываются
    // не сразу, а только через несколько секунд, пока крутится анимация.
    // На сервере списание и так атомарно и мгновенно (см. openCase() в
    // caseController.js), но на экране это не было видно — что выглядело
    // подозрительно и создавало ощущение, будто можно было бы "успеть"
    // что-то сделать до списания. Теперь показываем списание СРАЗУ, как
    // только сервер подтвердил открытие кейса (balanceAfterDebit — баланс
    // сразу после оплаты, ещё до начисления приза), а уже после того, как
    // анимация дойдёт до приза — обновляем на итоговый баланс с учётом
    // выигрыша (result.newBalance).
    updateBalanceUI(result.balanceAfterDebit);

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

/* ============================= ЛИДЕРЫ ============================= */

function leaderAvatarUrl(l) {
  // Фолбэк тот же, что и в профиле (см. loadProfile) — генерируем
  // стабильную аватарку по имени, если у игрока нет photo_url (Telegram
  // отдаёт его не всегда — например, если у пользователя приватность
  // фото ограничена).
  return l.photoUrl || 'https://api.dicebear.com/7.x/bottts/svg?seed=' + encodeURIComponent(l.firstName || 'player');
}

function renderLeaderRow(l, extraClass = '') {
  const topClass = l.rank === 1 ? 'top-1' : l.rank === 2 ? 'top-2' : l.rank === 3 ? 'top-3' : '';
  const el = document.createElement('div');
  el.className = `leader-card ${topClass} ${extraClass}`.trim();
  const medal = l.rank === 1 ? '🥇' : l.rank === 2 ? '🥈' : l.rank === 3 ? '🥉' : l.rank;
  el.innerHTML = `
    <div class="leaders-row">
      <span class="leaders-rank">${medal}</span>
      <img class="leaders-avatar" src="${leaderAvatarUrl(l)}" alt="" />
      <span class="leaders-name">${l.isYou ? 'Вы' : escapeHtml(l.firstName)}</span>
      <span class="leaders-total">${l.totalWagered.toLocaleString('ru-RU')} ⭐</span>
    </div>
  `;
  return el;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadLeaders(force = false) {
  const period = state.leadersPeriod;
  if (!force && state.leadersLoadedFor === period) return;

  const list = $('#leaders-list');
  const meCard = $('#leaders-me-card');
  const empty = $('#leaders-empty');
  list.innerHTML = '<div class="leader-card-skeleton"></div><div class="leader-card-skeleton"></div><div class="leader-card-skeleton"></div>';
  empty.classList.add('hidden');
  meCard.classList.add('hidden');

  try {
    const { leaders, me } = await Api.getLeaderboard(period);
    state.leadersLoadedFor = period;

    list.innerHTML = '';
    if (leaders.length === 0) {
      empty.classList.remove('hidden');
    } else {
      leaders.forEach((l) => list.appendChild(renderLeaderRow(l)));
    }

    // "Твоя позиция" показываем отдельной карточкой сверху ТОЛЬКО если ты
    // не попал в отображённый топ (иначе это просто задвоение своей же
    // строки, которая и так видна в списке).
    if (me && me.outsideTop) {
      $('#leaders-me-rank').textContent = me.rank;
      $('#leaders-me-avatar').src = leaderAvatarUrl(me);
      $('#leaders-me-name').textContent = 'Вы';
      $('#leaders-me-total').textContent = `${me.totalWagered.toLocaleString('ru-RU')} ⭐`;
      meCard.classList.remove('hidden');
    }
  } catch (e) {
    list.innerHTML = '';
    showToast(e.message, 'error');
  }
}

$$('.leaders-period-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('selected')) return;
    $$('.leaders-period-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.leadersPeriod = btn.dataset.period;
    loadLeaders(true);
  });
});



async function loadProfile() {
  try {
    const { user } = await Api.getProfile();
    state.profile = { user };
    const tgUser = TelegramBridge.getUser();

    $('#profile-avatar').src = tgUser.photo_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=' + user.telegram_id;
    $('#profile-name').textContent = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'Игрок';
    $('#profile-username').textContent = tgUser.username ? '@' + tgUser.username : '';
    $('#profile-level').textContent = user.account_level;
    $('#profile-cases').textContent = user.cases_opened;
    $('#profile-balance').textContent = user.coins_balance;

    // По умолчанию (если поле почему-то не пришло) считаем анонимность
    // включённой — так на бэкенде и заведено по умолчанию для новых юзеров.
    const anonToggle = $('#toggle-leaderboard-anon');
    if (anonToggle) anonToggle.checked = user.leaderboard_anonymous == null ? true : !!user.leaderboard_anonymous;

    updateBalanceUI(user.coins_balance);

    const { transactions } = await Api.getTransactions();
    renderTransactions(transactions);
    await loadMyPromos();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

const anonToggleEl = $('#toggle-leaderboard-anon');
if (anonToggleEl) {
  anonToggleEl.addEventListener('change', async () => {
    const anonymous = anonToggleEl.checked;
    anonToggleEl.disabled = true;
    try {
      const { user } = await Api.setLeaderboardVisibility(anonymous);
      if (state.profile) state.profile.user = user;
      showToast(anonymous ? 'В топе игроков вы теперь анонимны' : 'В топе игроков теперь видно ваше имя', 'success');
      // Если таблица лидеров уже загружалась, следующий заход должен
      // подтянуть актуальное отображение.
      state.leadersLoadedFor = null;
    } catch (e) {
      anonToggleEl.checked = !anonymous; // откатываем UI при ошибке запроса
      showToast(e.message, 'error');
    } finally {
      anonToggleEl.disabled = false;
    }
  });
}

const TX_LABELS = {
  case_open: '🎁 Открытие кейса',
  sell_item: '💸 Продажа предмета',
  admin_adjust: '⚙️ Корректировка',
  game_bet: '🎮 Ставка в игре',
  game_win: '🏆 Выигрыш в игре',
  self_topup: '⭐ Пополнение баланса',
  stars_topup: '⭐ Пополнение через Telegram Stars',
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


/* ============================= ПРОМОКОДЫ ============================= */

function openPromoModal(mode) {
  const create = $('#promo-create-form');
  const redeem = $('#promo-redeem-form');
  create.classList.toggle('hidden', mode !== 'create');
  redeem.classList.toggle('hidden', mode !== 'redeem');
  $('#promo-modal-title').textContent = mode === 'create' ? 'Создать чек' : 'Активировать чек';
  $('#promo-modal-subtitle').textContent = mode === 'create'
    ? 'Сумма за одно использование резервируется из твоего баланса сразу.'
    : 'Введи код, который отправил тебе друг.';
  $('#promo-modal').classList.remove('hidden');
  const input = mode === 'create' ? $('#promo-create-amount') : $('#promo-redeem-code');
  setTimeout(() => input.focus(), 50);
}

function closePromoModal() {
  $('#promo-modal').classList.add('hidden');
}

async function loadMyPromos() {
  const list = $('#promo-my-list');
  if (!list) return;
  try {
    const { promos } = await Api.getMyPromos();
    list.innerHTML = '';
    if (!promos.length) {
      list.innerHTML = '<p class="text-white/30 text-xs">Созданных чеков пока нет.</p>';
      return;
    }
    promos.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'bg-surface rounded-xl px-3 py-2 text-xs';
      const remaining = Math.max(0, Number(p.max_uses) - Number(p.used_uses));
      const isActive = p.status === 'active';
      const stateText = p.status === 'exhausted'
        ? 'Полностью использован'
        : p.status === 'cancelled'
          ? 'Деактивирован'
          : `Осталось ${remaining}`;
      row.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          <span class="font-mono font-bold text-white break-all">${p.code}</span>
          <span class="text-white/50 whitespace-nowrap">${p.amount_coins} ⭐ × ${p.max_uses}</span>
        </div>
        <div class="flex items-center justify-between gap-2 mt-1.5">
          <span class="text-white/40">${stateText}</span>
          ${isActive ? '<button class="promo-cancel-btn text-red-300 text-[11px] font-semibold px-2 py-1 rounded-lg bg-red-500/10" data-promo-id="' + p.id + '">Деактивировать</button>' : ''}
        </div>
      `;
      list.appendChild(row);
    });

    list.querySelectorAll('.promo-cancel-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const promoId = Number(btn.dataset.promoId);
        if (!promoId) return;
        if (!window.confirm('Деактивировать чек? Все неиспользованные ⭐ вернутся на баланс.')) return;
        btn.disabled = true;
        try {
          const result = await Api.cancelPromo(promoId);
          updateBalanceUI(result.newBalance);
          await loadProfile();
          TelegramBridge.haptic('success');
          showToast(`Чек деактивирован. Возвращено ${result.refund} ⭐`);
        } catch (e) {
          btn.disabled = false;
          showToast(e.message, 'error');
        }
      });
    });
  } catch (e) {
    list.innerHTML = '<p class="text-white/30 text-xs">Не удалось загрузить чеки.</p>';
  }
}

$('#btn-promo-create')?.addEventListener('click', () => openPromoModal('create'));
$('#btn-promo-redeem')?.addEventListener('click', () => openPromoModal('redeem'));
$('#btn-promo-close')?.addEventListener('click', closePromoModal);

$('#btn-promo-create-submit')?.addEventListener('click', async () => {
  const amount = Math.floor(Number($('#promo-create-amount').value));
  const maxUses = Math.floor(Number($('#promo-create-uses').value));
  if (!Number.isInteger(amount) || amount <= 0 || !Number.isInteger(maxUses) || maxUses <= 0) {
    showToast('Укажи сумму и количество использований.', 'error');
    return;
  }
  const btn = $('#btn-promo-create-submit');
  btn.disabled = true;
  try {
    const result = await Api.createPromo(amount, maxUses);
    updateBalanceUI(result.newBalance);
    closePromoModal();
    await loadProfile();
    TelegramBridge.haptic('success');
    showToast(`Чек ${result.code} создан. Списано ${result.reserved} ⭐`);
    setTimeout(() => window.prompt('Твой чек — скопируй его:', result.code), 50);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#btn-promo-redeem-submit')?.addEventListener('click', async () => {
  const code = $('#promo-redeem-code').value.trim().toUpperCase();
  if (!code) {
    showToast('Введи чек.', 'error');
    return;
  }
  const btn = $('#btn-promo-redeem-submit');
  btn.disabled = true;
  try {
    const result = await Api.redeemPromo(code);
    updateBalanceUI(result.newBalance);
    closePromoModal();
    await loadProfile();
    TelegramBridge.haptic('success');
    showToast(`Чек активирован: +${result.amount} ⭐`);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
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
  if (!Number.isInteger(amount) || amount <= 0) {
    showToast('Введите сумму больше нуля', 'error');
    return;
  }

  const confirmBtn = $('#btn-topup-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Создаём оплату...';

  try {
    // Баланс здесь НЕ меняется. Сервер только создаёт invoice в Telegram.
    const invoice = await Api.createTopupInvoice(amount);

    TelegramBridge.openInvoice(invoice.invoiceLink, async (status) => {
      if (status === 'paid') {
        // Telegram присылает successful_payment на webhook отдельно, поэтому
        // ждём подтверждение сервера и только после него обновляем баланс.
        for (let i = 0; i < 20; i += 1) {
          try {
            const payment = await Api.getTopupStatus(invoice.paymentId);
            if (payment.status === 'paid') {
              updateBalanceUI(payment.newBalance);
              showToast(`Баланс пополнен на ${payment.amount} ⭐`);
              TelegramBridge.haptic('success');
              $('#topup-modal').classList.add('hidden');
              return;
            }
          } catch (_) {}
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        showToast('Оплата прошла, но подтверждение ещё обрабатывается. Баланс обновится автоматически.', 'info');
        loadProfile();
      } else if (status === 'cancelled') {
        showToast('Оплата отменена');
      } else if (status === 'failed') {
        showToast('Telegram не смог провести оплату', 'error');
      } else if (status === 'not_supported') {
        showToast('Открытие Telegram Stars доступно только внутри Telegram', 'error');
      }
    });
  } catch (e) {
    showToast(e.message, 'error');
    TelegramBridge.haptic('error');
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Оплатить ⭐';
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
