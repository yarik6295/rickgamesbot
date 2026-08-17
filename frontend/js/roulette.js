/**
 * Горизонтальная рулетка кейс-открытия.
 *
 * Принцип честности: результат (winnerItem) уже ПОЛУЧЕН с сервера ДО начала
 * анимации. Рулетка лишь визуально "подводит" ленту к заранее известному
 * победителю — она никак не влияет на исход, только на UX ожидания.
 */
const Roulette = (() => {
  const ITEM_WIDTH = 104 + 12; // ширина .reel-item + margin (6px * 2)
  const REEL_LENGTH = 60;      // сколько карточек рендерим в ленте
  const WINNER_INDEX = 48;     // на какой позиции в ленте разместим победителя (ближе к концу)

  const track = document.getElementById('roulette-track');
  const viewport = track?.parentElement;

  function rarityClass(rarity) {
    return `rarity-${rarity}`;
  }

  function itemIcon() {
    // Единая иконка для всех призов кейса — звезда (награды это просто
    // звёзды, отдельные иконки по редкости больше не используются).
    return `<span>⭐</span>`;
  }

  function renderReelItem(item) {
    const el = document.createElement('div');
    el.className = `reel-item ${rarityClass(item.rarity)}`;
    el.innerHTML = `
      ${itemIcon(item)}
      <span class="reel-value">${item.value_coins} ⭐</span>
    `;
    return el;
  }

  /**
   * Строит ленту из случайных предметов пула (для визуального разнообразия),
   * подставляя реальный выигрышный предмет на фиксированную WINNER_INDEX позицию.
   *
   * @param {Array} pool - визуальный пул предметов кейса (reelPool с сервера)
   * @param {Object} winnerItem - фактический выигранный предмет (с сервера)
   */
  function buildReel(pool, winnerItem) {
    track.innerHTML = '';
    track.style.transition = 'none';
    track.style.transform = 'translateX(0px)';

    for (let i = 0; i < REEL_LENGTH; i++) {
      let itemToRender;
      if (i === WINNER_INDEX) {
        itemToRender = winnerItem;
      } else {
        itemToRender = pool[Math.floor(Math.random() * pool.length)];
      }
      const el = renderReelItem(itemToRender);
      if (i === WINNER_INDEX) el.dataset.winner = 'true';
      track.appendChild(el);
    }
  }

  /**
   * Запускает анимацию прокрутки до победителя с плавным замедлением
   * (cubic-bezier "ease-out"-подобная кривая на CSS transition).
   * @returns {Promise<void>} резолвится, когда анимация завершена
   */
  function spinTo() {
    return new Promise((resolve) => {
      const viewportWidth = viewport.getBoundingClientRect().width;
      const centerOffset = viewportWidth / 2 - ITEM_WIDTH / 2;

      // Небольшой случайный джиттер в пикселях, чтобы указатель не всегда
      // останавливался идеально по центру карточки (более живой эффект)
      const jitter = (Math.random() - 0.5) * (ITEM_WIDTH * 0.3);

      const targetX = -(WINNER_INDEX * ITEM_WIDTH) + centerOffset - jitter;

      // Форсируем reflow, чтобы transition сработал после сброса transform в buildReel
      // eslint-disable-next-line no-unused-expressions
      track.offsetHeight;

      const DURATION_MS = 5200;
      track.style.transition = `transform ${DURATION_MS}ms cubic-bezier(0.12, 0.72, 0.1, 1)`;
      track.style.transform = `translateX(${targetX}px)`;

      // Если пока крутится лента пользователь уходит с экрана рулетки (кнопка
      // "назад", переключение таба), родительская панель получает display:none.
      // Браузер в этом случае НЕ шлёт 'transitionend' — событие просто теряется,
      // и без страховки этот промис зависал бы навсегда. Из-за этого в app.js
      // не отрабатывал finally у обработчика "Открыть кейс", state.isSpinning
      // оставался true, и повторный клик по любому кейсу молча ничего не делал
      // (см. guard "if (state.isSpinning ...) return;"). Поэтому дублируем
      // резолв таймером чуть дольше длительности анимации — что бы ни случилось
      // с видимостью экрана, промис гарантированно завершится.
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        track.removeEventListener('transitionend', onEnd);
        clearTimeout(fallbackTimer);
        const winnerEl = track.querySelector('[data-winner="true"]');
        winnerEl?.classList.add('winner');
        resolve();
      };
      const onEnd = () => finish();
      track.addEventListener('transitionend', onEnd);
      const fallbackTimer = setTimeout(finish, DURATION_MS + 400);
    });
  }

  /**
   * Полный цикл: построить ленту + прокрутить до победителя.
   */
  async function play(pool, winnerItem) {
    buildReel(pool, winnerItem);
    // Даём браузеру отрисовать стартовое состояние перед стартом transition
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await spinTo();
  }

  function reset() {
    track.innerHTML = '';
    track.style.transition = 'none';
    track.style.transform = 'translateX(0px)';
  }

  /**
   * Статичный (не крутящийся) показ пула возможных призов кейса —
   * вызывается сразу при входе на экран кейса, ДО нажатия "Открыть",
   * чтобы игрок видел, что может выпасть.
   * @param {Array} items - пул наград кейса (id, value_coins, rarity)
   */
  function preview(items) {
    track.style.transition = 'none';
    track.style.transform = 'translateX(0px)';
    track.innerHTML = '';
    items.forEach((item) => track.appendChild(renderReelItem(item)));
  }

  /**
   * БАГ (исправлено): раньше при входе на экран кейса лента была пустой
   * (Roulette.reset() её просто чистит), пока не подгрузится preview() —
   * а фон .roulette-wrap тёмный (#0c0c16), поэтому визуально это выглядело
   * как "чёрный экран, который появляется с задержкой" (задержка = время
   * сетевого запроса/рендера, которое в реальных условиях Telegram может
   * быть заметно больше, чем на локальном тесте).
   *
   * Показывает мгновенно (без единого await) заглушки-карточки с shimmer-
   * анимацией — вызывается СИНХРОННО в момент открытия экрана кейса, ещё
   * до какого-либо запроса к серверу. preview()/play() потом просто
   * перезатирают track.innerHTML реальным содержимым, так что подмена
   * происходит бесшовно, а "чёрного экрана" не бывает в принципе, вне
   * зависимости от скорости сети.
   */
  function skeleton(count = 6) {
    track.style.transition = 'none';
    track.style.transform = 'translateX(0px)';
    track.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'reel-item reel-item-skeleton';
      track.appendChild(el);
    }
  }

  return { play, reset, preview, skeleton };
})();
