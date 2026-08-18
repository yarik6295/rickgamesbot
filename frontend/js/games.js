/**
 * Логика игровых экранов. Все ставки, RNG и расчёт выигрыша — на сервере
 * (см. backend/src/controllers/gamesController.js). Клиент только
 * отправляет действия и анимирует то, что вернул сервер.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  function bindBetAdjusters(scope) {
    scope.querySelectorAll('.bet-adj').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = btn.parentElement.querySelector('.bet-input');
        const delta = Number(btn.dataset.adj);
        const next = Math.max(5, (Number(input.value) || 0) + delta);
        input.value = next;
      });
    });
  }
  document.querySelectorAll('.bet-input-row').forEach((row) => bindBetAdjusters(row.parentElement));

  function toast(msg, type) { window.showToast ? window.showToast(msg, type) : console.log(msg); }

  /* ============================ КНОПКА "MAX" ============================
   * Во всех полях ставок (Crash, Mines, Towers, Plinko, Upgrade, Wheel)
   * подставляет максимально возможную ставку: минимум из текущего баланса
   * игрока и общего лимита ставки (см. backend: MAX_BET = 100000 в
   * gamesController.js и crashEngine.js). Значение округляется вниз до
   * шага поля (step), чтобы бэкенд не отклонил ставку как "не integer/step".
   */
  const GLOBAL_MAX_BET = 100000;

  function getCurrentBalance() {
    // `state` объявлен через const в app.js (подключается раньше games.js) —
    // как top-level const/let в классическом <script>, он не попадает в
    // window, но виден как обычная переменная в этом же документе.
    try {
      if (typeof state !== 'undefined' && state?.profile?.user) {
        const b = Number(state.profile.user.coins_balance);
        if (Number.isFinite(b)) return b;
      }
    } catch (e) { /* state ещё не готов — fallback ниже */ }
    const el = document.getElementById('balance-value');
    const parsed = Number((el?.textContent || '0').replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  document.querySelectorAll('.bet-max-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const balance = getCurrentBalance();
      const min = Number(input.min) || 5;
      const step = Number(input.step) || 5;

      if (balance < min) {
        toast('Недостаточно звёзд для ставки', 'error');
        return;
      }

      let max = Math.min(balance, GLOBAL_MAX_BET);
      max = Math.floor(max / step) * step; // выравниваем по шагу поля
      max = Math.max(min, max);

      input.value = max;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      // если это Crash — снимаем подсветку с быстрых кнопок ставки,
      // т.к. значение больше не соответствует ни одной из них
      document.querySelectorAll('.crash-quick-btn').forEach((b) => b.classList.remove('selected'));
      TelegramBridge?.haptic?.('light');
    });
  });

  /* ================================ CRASH ================================
   * Раунд общий и непрерывный для ВСЕХ игроков (см. backend crashEngine.js):
   * waiting (приём ставок) → flying (мультипликатор растёт) → crashed →
   * снова waiting. Клиент не запускает свой раунд — он лишь читает текущую
   * фазу общего раунда (GET /crash/state, опрос) и между опросами сам
   * досчитывает мультипликатор локально (requestAnimationFrame) по той же
   * формуле, что и сервер, — картинка плавная, а любые расхождения
   * поправляются на следующем опросе. Источник истины по-прежнему сервер:
   * реальный кэшаут и итог раунда решает он.
   */
  const Crash = {
    pollTimer: null,
    rafId: null,
    phase: 'waiting',
    waitingDeadline: 0,
    flyingStartedAt: 0,
    growthK: 0.11,
    crashPoint: null,
    myBet: null,       // { bet, cashedOut, cashoutMultiplier, payout } | null
    curvePoints: [],
    autoTriggered: false,
    busy: false,
    // Локально посчитанный мультипликатор на последний кадр — именно то
    // число, которое игрок реально видел на экране в момент клика
    // "Забрать"/срабатывания автовывода. Отправляем его на сервер вместе
    // с запросом кэшаута (см. cashout() ниже) — иначе даже при мгновенном
    // ответе сервера кривая успевает подрасти за время сетевой передачи
    // запроса, и итоговая выплата оказывается выше того, что видел игрок.
    currentMult: 1,
    // Счётчик локальных мутаций ставки (bet/cashout). Опрос состояния (poll)
    // идёт по таймеру раз в 400мс независимо от кликов — если poll-запрос
    // улетел на сервер ДО того, как пользователь нажал "Забрать", а ответ
    // пришёл ПОСЛЕ того, как cashout уже успешно прошёл, он затирал this.myBet
    // устаревшими данными (без отметки о выводе), и повторный клик по кнопке
    // молча ничего не делал — return на строке "if (this.busy || !this.myBet
    // || this.myBet.cashedOut) return". Именно это и было "через раз не
    // кликается". mutationSeq защищает от этой гонки: любой poll, стартовавший
    // до локальной мутации, не имеет права перезаписать myBet.
    mutationSeq: 0,

    async resume() {
      this.stop();
      await this.poll();
      this.pollTimer = setInterval(() => this.poll(), 400);
      this.loop();
    },

    stop() {
      clearInterval(this.pollTimer);
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
    },

    async poll() {
      const seqAtStart = this.mutationSeq;
      try {
        const res = await Api.crashState();
        this.applyState(res, seqAtStart);
      } catch (e) { /* сеть моргнула — досчитаем локально до следующего опроса */ }
    },

    applyState(res, seqAtStart) {
      const prevPhase = this.phase;
      this.phase = res.phase;
      // Применяем myBet из poll'а, только если за время его полёта до сервера
      // и обратно не произошло локальной мутации (bet/cashout) — иначе это
      // устаревший ответ, который затрёт свежее состояние гонкой (см. комментарий
      // у mutationSeq выше).
      if (seqAtStart === this.mutationSeq) {
        this.myBet = res.myBet;
      }
      this.renderPlayers(res.playersCount);
      this.renderHistory(res.history);

      if (res.phase === 'waiting') {
        this.waitingDeadline = Date.now() + res.msLeft;
        if (prevPhase !== 'waiting') { this.curvePoints = []; this.autoTriggered = false; }
      } else if (res.phase === 'flying') {
        this.flyingStartedAt = res.flyingStartedAt;
        this.growthK = res.growthK;
        if (prevPhase !== 'flying') this.curvePoints = [];
      } else if (res.phase === 'crashed') {
        this.crashPoint = res.crashPoint;
        if (prevPhase === 'flying') this.onCrash();
      }
      this.renderButtons();
    },

    onCrash() {
      $('#crash-multiplier').textContent = (this.crashPoint || 1).toFixed(2) + 'x';
      $('#crash-multiplier').classList.add('crash-busted');
      this.positionRocket(0, this.crashPoint || 1);
      TelegramBridge.haptic('error');
      if (this.myBet && !this.myBet.cashedOut) {
        $('#crash-status-label').textContent = `Улетело на ×${(this.crashPoint || 1).toFixed(2)} 💥 — ставка сгорела`;
      } else if (this.myBet && this.myBet.cashedOut) {
        $('#crash-status-label').textContent = `Раунд завершён — вы забрали ×${this.myBet.cashoutMultiplier.toFixed(2)}`;
      } else {
        $('#crash-status-label').textContent = `Крашнулось на ×${(this.crashPoint || 1).toFixed(2)}`;
      }
    },

    renderPlayers(count) {
      $('#crash-players-count').textContent = count;
    },

    renderHistory(history) {
      const wrap = $('#crash-history');
      wrap.innerHTML = history.slice(0, 12).map((p) => {
        let cls = 'crash-chip-low';
        if (p >= 10) cls = 'crash-chip-huge';
        else if (p >= 2) cls = 'crash-chip-mid';
        return `<span class="crash-chip ${cls}">${p.toFixed(2)}x</span>`;
      }).join('');
    },

    renderButtons() {
      const betBtn = $('#btn-crash-bet');
      const cashoutBtn = $('#btn-crash-cashout');
      const myBetLabel = $('#crash-my-bet-label');

      if (this.myBet) {
        myBetLabel.style.display = '';
        $('#crash-my-bet-amount').textContent = this.myBet.bet;
      } else {
        myBetLabel.style.display = 'none';
      }

      if (this.phase === 'waiting') {
        cashoutBtn.classList.add('hidden');
        betBtn.classList.remove('hidden');
        if (this.myBet) {
          betBtn.disabled = true;
          betBtn.textContent = 'Ставка принята ✅';
        } else {
          betBtn.disabled = this.busy;
          betBtn.textContent = 'Сделать ставку ⭐';
        }
      } else if (this.phase === 'flying') {
        if (this.myBet && !this.myBet.cashedOut) {
          betBtn.classList.add('hidden');
          cashoutBtn.classList.remove('hidden');
          cashoutBtn.disabled = this.busy;
        } else if (this.myBet && this.myBet.cashedOut) {
          betBtn.classList.add('hidden');
          cashoutBtn.classList.remove('hidden');
          cashoutBtn.disabled = true;
          cashoutBtn.textContent = `Забрано ×${this.myBet.cashoutMultiplier.toFixed(2)} ✅`;
        } else {
          cashoutBtn.classList.add('hidden');
          betBtn.classList.remove('hidden');
          betBtn.disabled = true;
          betBtn.textContent = 'Ставки закрыты — раунд идёт';
        }
      } else {
        // crashed
        cashoutBtn.classList.add('hidden');
        betBtn.classList.remove('hidden');
        betBtn.disabled = true;
        betBtn.textContent = 'Ожидайте новый раунд…';
      }
    },

    maybeAutoCashout(mult) {
      if (this.autoTriggered) return;
      if (!this.myBet || this.myBet.cashedOut) return;
      const target = Number($('#crash-autocashout').value);
      if (!target || target < 1.01) return;
      if (mult >= target) {
        this.autoTriggered = true;
        this.cashout(true);
      }
    },

    loop() {
      this.rafId = requestAnimationFrame(() => this.loop());
      const now = Date.now();

      if (this.phase === 'waiting') {
        const msLeft = Math.max(0, this.waitingDeadline - now);
        $('#crash-status-label').textContent = `Старт через ${Math.ceil(msLeft / 1000)}с — принимаем ставки`;
        $('#crash-multiplier').textContent = '1.00x';
        $('#crash-multiplier').classList.remove('crash-busted');
        this.drawCurve(1, true);
        this.positionRocket(0, 1);
      } else if (this.phase === 'flying') {
        const t = Math.max(0, (now - this.flyingStartedAt) / 1000);
        const mult = Math.max(1, Math.round(Math.exp(this.growthK * t) * 100) / 100);
        this.currentMult = mult;
        $('#crash-multiplier').textContent = mult.toFixed(2) + 'x';
        $('#crash-status-label').textContent = 'В полёте 🚀';
        this.curvePoints.push({ t, mult });
        if (this.curvePoints.length > 600) this.curvePoints.shift();
        this.drawCurve(mult, false);
        this.positionRocket(t, mult);
        if (this.myBet && !this.myBet.cashedOut) {
          $('#crash-cashout-mult').textContent = mult.toFixed(2);
          const potential = $('#crash-cashout-potential');
          if (potential) potential.textContent = Math.floor(this.myBet.bet * mult);
          this.maybeAutoCashout(mult);
        }
      }
      // crashed: оставляем последний отрисованный кадр как есть
    },

    drawCurve(currentMult, isWaiting) {
      const canvas = $('#crash-canvas');
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      if (canvas.width !== cw * dpr) canvas.width = cw * dpr;
      if (canvas.height !== ch * dpr) canvas.height = ch * dpr;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (isWaiting || this.curvePoints.length < 2) return;

      const last = this.curvePoints[this.curvePoints.length - 1];
      const xMax = Math.max(6, last.t * 1.15);
      const yMax = Math.max(2, last.mult * 1.25);
      const pad = 12 * dpr;
      const w = canvas.width, h = canvas.height;
      const xOf = (t) => pad + (t / xMax) * (w - pad * 2);
      const yOf = (m) => h - pad - ((m - 1) / (yMax - 1)) * (h - pad * 2);

      // область под кривой
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(1));
      this.curvePoints.forEach((p) => ctx.lineTo(xOf(p.t), yOf(p.mult)));
      ctx.lineTo(xOf(last.t), h - pad);
      ctx.lineTo(xOf(0), h - pad);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      const busted = this.phase === 'crashed';
      grad.addColorStop(0, busted ? 'rgba(255,46,136,.35)' : 'rgba(0,246,255,.32)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fill();

      // линия кривой
      ctx.beginPath();
      this.curvePoints.forEach((p, i) => {
        const x = xOf(p.t), y = yOf(p.mult);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = busted ? '#ff2e88' : '#00f6ff';
      ctx.shadowColor = busted ? 'rgba(255,46,136,.8)' : 'rgba(0,246,255,.8)';
      ctx.shadowBlur = 10 * dpr;
      ctx.stroke();
      ctx.shadowBlur = 0;
    },

    /* Ракета всегда в центре сцены: во время полёта держится строго
     * вертикально и трясётся от тяги — сильнее по мере роста множителя,
     * а вокруг неё бегут потоки воздуха (создают ощущение подъёма без
     * реального перемещения ракеты по экрану). */
    positionRocket(t, mult) {
      const zone = $('#crash-rocket-zone');
      if (!zone) return;
      zone.classList.remove('is-flying', 'is-crashed');
      if (this.phase === 'flying') {
        zone.classList.add('is-flying');
        // чем выше мультипликатор — тем сильнее тряска от тяги и быстрее потоки воздуха
        const shake = Math.min(4, 1 + Math.log10(mult) * 1.6);
        const flowSpeed = Math.max(0.32, 0.85 / Math.sqrt(mult));
        zone.style.setProperty('--shake', shake.toFixed(1) + 'px');
        zone.style.setProperty('--flow-speed', flowSpeed.toFixed(2) + 's');
      } else if (this.phase === 'crashed') {
        zone.classList.add('is-crashed');
      }
      // waiting: без классов — спокойное покачивание (см. rocketIdle в CSS)
    },

    async bet() {
      const amount = Number($('#crash-bet').value);
      if (this.busy) return;
      this.busy = true;
      this.mutationSeq++;
      this.renderButtons();
      try {
        const res = await Api.crashBet(amount);
        window.updateBalanceUI(res.newBalance);
        this.myBet = { bet: amount, cashedOut: false, cashoutMultiplier: null, payout: 0 };
        TelegramBridge.haptic('success');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        this.busy = false;
        this.renderButtons();
      }
    },

    async cashout(isAuto) {
      if (this.busy) return;
      if (!this.myBet || this.myBet.cashedOut) {
        // Ставки нет или уже забрана — не молчим, а объясняем, что произошло,
        // чтобы не выглядело как "кнопка не реагирует".
        if (!isAuto) toast('Ставка уже забрана или её нет', 'error');
        return;
      }
      // Фиксируем локально посчитанный мультипликатор ПРЯМО СЕЙЧАС, до
      // отправки запроса — это и есть то число, которое игрок увидел на
      // экране в момент клика (см. комментарий у this.currentMult).
      const seenMultiplier = this.currentMult;
      this.busy = true;
      this.mutationSeq++;
      this.renderButtons();
      try {
        const res = await Api.crashCashout(seenMultiplier);
        window.updateBalanceUI(res.newBalance);
        this.myBet.cashedOut = true;
        this.myBet.cashoutMultiplier = res.multiplier;
        this.myBet.payout = res.payout;
        toast(`${isAuto ? 'Авто-вывод: ' : ''}Забрано ${res.payout} ⭐ (×${res.multiplier.toFixed(2)})`);
        TelegramBridge.haptic('success');
      } catch (e) {
        toast(e.message, 'error');
        // Сервер уже знает, что раунд лопнул — не ждём следующего опроса
        if (e.data && e.data.crashPoint) {
          this.phase = 'crashed';
          this.crashPoint = e.data.crashPoint;
          this.onCrash();
        }
      } finally {
        this.busy = false;
        this.renderButtons();
      }
    },
  };

  $('#btn-crash-bet').addEventListener('click', () => Crash.bet());
  $('#btn-crash-cashout').addEventListener('click', () => Crash.cashout(false));
  $('#crash-bet-half').addEventListener('click', () => {
    const input = $('#crash-bet');
    input.value = Math.max(5, Math.round((Number(input.value) || 0) / 2 / 5) * 5);
  });
  $('#crash-bet-double').addEventListener('click', () => {
    const input = $('#crash-bet');
    input.value = Math.min(100000, Math.round((Number(input.value) || 0) * 2 / 5) * 5);
  });
  document.querySelectorAll('.crash-quick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#crash-bet').value = btn.dataset.amt;
      document.querySelectorAll('.crash-quick-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  /* ================================ MINES ================================ */
  const Mines = {
    gridSize: 25,
    active: false,
    revealed: [],
    busy: false,

    reset() {
      this.active = false;
      this.revealed = [];
      $('#mines-setup').classList.remove('hidden');
      $('#btn-mines-start').classList.remove('hidden');
      $('#btn-mines-start').disabled = false;
      $('#btn-mines-cashout').classList.add('hidden');
      this.renderGrid();
    },

    // Отличие от reset(): раунд завершён (проигрыш/кэшаут), но сетку НЕ
    // перерисовываем — экран с результатом (открытые клетки, мины) должен
    // оставаться на виду, пока игрок сам не нажмёт "Начать раунд" (тогда
    // сработает полноценный reset() внутри start()).
    endRound() {
      this.active = false;
      $('#mines-setup').classList.remove('hidden');
      $('#btn-mines-start').classList.remove('hidden');
      $('#btn-mines-start').disabled = false;
      $('#btn-mines-cashout').classList.add('hidden');
    },

    // См. комментарий у Crash.resume() — тот же фикс восстановления
    // состояния раунда, который мог "потеряться" для UI при возврате
    // на экран (пока сервер всё ещё считал раунд активным).
    async resume() {
      try {
        const res = await Api.minesStatus();
        if (res.active) {
          this.active = true;
          this.gridSize = res.gridSize;
          this.revealed = res.revealed;
          $('#mines-setup').classList.add('hidden');
          $('#btn-mines-start').classList.add('hidden');
          $('#btn-mines-cashout').classList.remove('hidden');
          $('#btn-mines-cashout').disabled = res.revealed.length === 0;
          $('#mines-payout').textContent = res.potentialPayout;
          $('#mines-mult').textContent = res.multiplier.toFixed(2);
          this.renderGrid();
          res.revealed.forEach((idx) => {
            const cell = document.querySelector(`.mine-cell[data-idx="${idx}"]`);
            if (cell) { cell.classList.add('mine-safe'); cell.textContent = '💎'; }
          });
          return;
        }
      } catch (e) { /* нет активного раунда/ошибка сети — обычный старт-экран */ }
      this.reset();
    },

    renderGrid() {
      const grid = $('#mines-grid');
      grid.innerHTML = '';
      for (let i = 0; i < this.gridSize; i++) {
        const cell = document.createElement('button');
        cell.className = 'mine-cell';
        cell.dataset.idx = i;
        if (this.active) {
          cell.addEventListener('click', () => {
            // Тот же фикс, что и в Towers (см. подробный комментарий там):
            // мгновенная реакция на тап, не полагаемся на CSS :active,
            // которое в WebKit на iOS по тапу часто вообще не срабатывает.
            if (this.busy || this.revealed.includes(i)) return;
            cell.classList.add('mine-pending');
            this.reveal(i);
          });
        }
        grid.appendChild(cell);
      }
    },

    async start() {
      // Защита от двойного сабмита: без этой проверки быстрый двойной клик
      // по "Начать раунд" мог отправить два запроса подряд, и второй падал
      // с 409 "уже есть активный раунд" ещё до того, как первый успевал
      // обновить UI (кнопка не блокировалась на время запроса).
      if (this.busy) return;
      this.busy = true;
      const bet = Number($('#mines-bet').value);
      const mineCount = Number($('#mines-count-row .selected')?.dataset.count || 3);
      const startBtn = $('#btn-mines-start');
      startBtn.disabled = true;
      try {
        const res = await Api.minesStart(bet, mineCount);
        window.updateBalanceUI(res.newBalance);
        this.active = true;
        this.revealed = [];
        $('#mines-setup').classList.add('hidden');
        $('#btn-mines-start').classList.add('hidden');
        $('#btn-mines-cashout').classList.remove('hidden');
        $('#btn-mines-cashout').disabled = true;
        $('#mines-payout').textContent = '0';
        $('#mines-mult').textContent = '1.00';
        this.renderGrid();
      } catch (e) {
        toast(e.message, 'error');
        startBtn.disabled = false;
      } finally {
        this.busy = false;
      }
    },

    async reveal(idx) {
      if (!this.active || this.busy || this.revealed.includes(idx)) return;
      this.busy = true;
      const cell = document.querySelector(`.mine-cell[data-idx="${idx}"]`);
      try {
        const res = await Api.minesReveal(idx);
        if (res.hit) {
          this.active = false;
          res.mines.forEach((m) => {
            const c = document.querySelector(`.mine-cell[data-idx="${m}"]`);
            c.classList.add('mine-boom');
            c.textContent = '💣';
          });
          TelegramBridge.haptic('error');
          toast('Бум! Раунд проигран', 'error');
          window.updateBalanceUI(res.newBalance);
          this.endRound();
          return;
        }
        this.revealed = res.revealed;
        cell.classList.add('mine-safe');
        cell.textContent = '💎';
        $('#mines-mult').textContent = res.multiplier.toFixed(2);
        $('#mines-payout').textContent = res.potentialPayout;
        $('#btn-mines-cashout').disabled = false;
        TelegramBridge.haptic('light');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        this.busy = false;
      }
    },

    async cashout() {
      if (this.busy) return;
      this.busy = true;
      const cashoutBtn = $('#btn-mines-cashout');
      cashoutBtn.disabled = true;
      try {
        const res = await Api.minesCashout();
        this.active = false;
        window.updateBalanceUI(res.newBalance);
        toast(`Забрано ${res.payout} ⭐ (×${res.multiplier.toFixed(2)})`);
        TelegramBridge.haptic('success');
        // Раунд уже выигран — показываем, где были мины (приглушённо,
        // не как "бум"), чтобы было видно, насколько повезло/не повезло.
        (res.mines || []).forEach((m) => {
          if (this.revealed.includes(m)) return;
          const c = document.querySelector(`.mine-cell[data-idx="${m}"]`);
          if (c) { c.classList.add('mine-revealed'); c.textContent = '💣'; }
        });
        this.endRound();
      } catch (e) {
        toast(e.message, 'error');
        cashoutBtn.disabled = false;
      } finally {
        this.busy = false;
      }
    },
  };

  $('#btn-mines-start').addEventListener('click', () => Mines.start());
  $('#btn-mines-cashout').addEventListener('click', () => Mines.cashout());
  document.querySelectorAll('#mines-count-row .mine-count-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#mines-count-row .mine-count-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });
  Mines.renderGrid();

  /* ================================ TOWERS ================================ */
  const Towers = {
    rows: 8,
    tilesPerRow: 3,
    active: false,
    currentRow: 0,
    busy: false,
    revealed: [],       // индекс выбранной (безопасной) плитки в каждом пройденном ряду
    bombPositions: [],  // индекс мины в каждом пройденном ряду — теперь сервер отдаёт её сразу
    fullLayout: null,   // полный расклад мин по ВСЕМ рядам — приходит с сервера только
                         // при проигрыше (res.layout), нужен чтобы показать мины и в
                         // ещё не пройденных рядах, а не только в уже сыгранных

    reset() {
      this.active = false;
      this.currentRow = 0;
      this.revealed = [];
      this.bombPositions = [];
      this.fullLayout = null;
      $('#towers-setup').classList.remove('hidden');
      $('#btn-towers-start').classList.remove('hidden');
      $('#btn-towers-start').disabled = false;
      $('#btn-towers-cashout').classList.add('hidden');
      this.renderTower();
    },

    // Отличие от reset(): раунд завершён (проигрыш/кэшаут/полное
    // прохождение), но саму башню НЕ сбрасываем — доска с итогом (кто где
    // стоял, где была мина) должна оставаться на виду, пока игрок сам не
    // нажмёт "Начать раунд" (тогда сработает полноценный reset() внутри
    // start()). Рендер доски НЕ делаем здесь — вызывающий код (pick/cashout)
    // уже вызвал renderTower() с нужным контекстом (например, с bombRow при
    // проигрыше); повторный вызов без контекста стёр бы эту подсветку.
    endRound() {
      this.active = false;
      $('#towers-setup').classList.remove('hidden');
      $('#btn-towers-start').classList.remove('hidden');
      $('#btn-towers-start').disabled = false;
      $('#btn-towers-cashout').classList.add('hidden');
    },

    // См. комментарий у Crash.resume() / Mines.resume() — та же логика
    // восстановления активного раунда после возврата на экран.
    async resume() {
      try {
        const res = await Api.towersStatus();
        if (res.active) {
          this.active = true;
          this.rows = res.rows;
          this.tilesPerRow = res.tilesPerRow;
          this.currentRow = res.currentRow;
          this.revealed = res.revealed || [];
          this.bombPositions = res.bombPositions || [];
          $('#towers-setup').classList.add('hidden');
          $('#btn-towers-start').classList.add('hidden');
          $('#btn-towers-cashout').classList.remove('hidden');
          $('#btn-towers-cashout').disabled = res.currentRow === 0;
          $('#towers-payout').textContent = res.potentialPayout;
          $('#towers-mult').textContent = res.multiplier.toFixed(2);
          this.renderTower();
          return;
        }
      } catch (e) { /* нет активного раунда/ошибка сети — обычный старт-экран */ }
      this.reset();
    },

    // БАГ (исправлено): раньше пройденные ряды все три плитки красились
    // одинаковым "cleared"-стилем — было физически невозможно понять,
    // какую именно плитку выбрал игрок, и мина в пройденном ряду нигде не
    // показывалась. Теперь: выбранная (безопасная) плитка помечается ✅,
    // а плитка с миной — приглушённой 💣 (this.bombPositions приходит с
    // сервера, см. towersPick/towersStatus).
    //
    // БАГ 2 (исправлено): при проигрыше сервер (towersPick) уже присылает
    // ПОЛНЫЙ расклад мин по всем 8 рядам (res.layout), но раньше здесь
    // использовался только res.layout[currentRow] — расклад для ещё не
    // пройденных рядов просто выбрасывался, и после взрыва игрок видел
    // мину только в том ряду, где подорвался, а все ряды выше оставались
    // пустыми плитками. Теперь при проигрыше (this.fullLayout заполнен)
    // мины показываются во ВСЕХ рядах, включая непройденные.
    renderTower(bombRow = null) {
      const el = $('#towers-tower');
      el.innerHTML = '';
      for (let r = this.rows - 1; r >= 0; r--) {
        const row = document.createElement('div');
        // Приглушаем только будущие ряды, и только пока раунд реально
        // идёт — до старта и после завершения раунда доска полностью
        // видима (см. комментарий у .towers-row-dim в CSS).
        let rowClass = 'towers-row';
        if (r === this.currentRow && this.active) rowClass += ' towers-row-active';
        else if (this.active && r > this.currentRow) rowClass += ' towers-row-dim';
        row.className = rowClass;
        for (let t = 0; t < this.tilesPerRow; t++) {
          const tile = document.createElement('button');
          tile.className = 'towers-tile';
          if (r < this.currentRow) {
            tile.classList.add('towers-tile-cleared');
            if (t === this.revealed[r]) {
              tile.classList.add('towers-tile-picked');
              tile.textContent = '✅';
            } else if (t === this.bombPositions[r]) {
              tile.classList.add('towers-tile-bomb-revealed');
              tile.textContent = '💣';
            }
          }
          if (bombRow && bombRow.row === r && bombRow.bombs.includes(t)) {
            tile.classList.add('towers-tile-bomb');
            tile.textContent = '💣';
          }
          // Непройденные ряды (r > currentRow): показываем, где были мины,
          // только если раунд уже закончился проигрышем и сервер прислал
          // полный расклад (fullLayout). Пока раунд активен, fullLayout
          // всегда null — честность игры (мины будущих рядов) не нарушена.
          if (this.fullLayout && r > this.currentRow && this.fullLayout[r]?.includes(t)) {
            tile.classList.add('towers-tile-bomb-future');
            tile.textContent = '💣';
          }
          if (r === this.currentRow && this.active) {
            tile.addEventListener('click', () => {
              // Мгновенная визуальная реакция на тап — не полагаемся на CSS
              // :active (в WebKit/Telegram WebView на iOS :active по тапу
              // часто вообще не срабатывает без touchstart-хендлера, из-за
              // чего казалось, что после нажатия ничего не происходит целых
              // ~0.5с, пока не придёт ответ сервера). Подсвечиваем плитку и
              // блокируем ряд от повторных тапов сразу, синхронно, ещё до
              // отправки запроса — реальный результат (бомба/безопасно)
              // всё равно приходит только с сервера, раньше его показать
              // нельзя (честность игры), но реакция на сам тап теперь мгновенная.
              if (this.busy) return;
              tile.classList.add('towers-tile-pending');
              row.classList.add('towers-row-locked');
              this.pick(t);
            });
          }
          row.appendChild(tile);
        }
        el.appendChild(row);
      }
    },

    async start() {
      if (this.busy) return;
      this.busy = true;
      const bet = Number($('#towers-bet').value);
      const startBtn = $('#btn-towers-start');
      startBtn.disabled = true;
      try {
        const res = await Api.towersStart(bet);
        window.updateBalanceUI(res.newBalance);
        this.active = true;
        this.currentRow = 0;
        this.revealed = [];
        this.bombPositions = [];
        this.fullLayout = null;
        $('#towers-setup').classList.add('hidden');
        $('#btn-towers-start').classList.add('hidden');
        $('#btn-towers-cashout').classList.remove('hidden');
        $('#btn-towers-cashout').disabled = true;
        $('#towers-payout').textContent = '0';
        $('#towers-mult').textContent = '1.00';
        this.renderTower();
      } catch (e) {
        toast(e.message, 'error');
        startBtn.disabled = false;
      } finally {
        this.busy = false;
      }
    },

    async pick(tileIdx) {
      if (!this.active || this.busy) return;
      this.busy = true;
      try {
        const res = await Api.towersPick(tileIdx);
        if (res.hit) {
          this.active = false;
          this.fullLayout = res.layout;
          this.renderTower({ row: this.currentRow, bombs: res.layout[this.currentRow] });
          TelegramBridge.haptic('error');
          toast('Это была бомба! Раунд проигран', 'error');
          window.updateBalanceUI(res.newBalance);
          this.endRound();
          return;
        }
        this.currentRow++;
        this.revealed = res.revealed;
        this.bombPositions = res.bombPositions;
        $('#towers-mult').textContent = res.multiplier.toFixed(2);
        $('#btn-towers-cashout').disabled = false;
        TelegramBridge.haptic('light');

        if (res.completed) {
          this.active = false;
          window.updateBalanceUI(res.newBalance);
          toast(`Башня пройдена! +${res.payout} ⭐`);
          TelegramBridge.haptic('success');
          this.renderTower();
          this.endRound();
          return;
        }
        $('#towers-payout').textContent = res.potentialPayout;
        this.renderTower();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        // БАГ (исправлено): раньше busy не сбрасывался ни при взрыве, ни при
        // обычном шаге, ни при ошибке — после первого же клика по плитке
        // весь Towers намертво блокировался (в т.ч. кнопка "Начать раунд"
        // следующего захода, она тоже проверяет this.busy).
        this.busy = false;
      }
    },

    async cashout() {
      if (this.busy) return;
      this.busy = true;
      const cashoutBtn = $('#btn-towers-cashout');
      cashoutBtn.disabled = true;
      try {
        const res = await Api.towersCashout();
        this.active = false;
        window.updateBalanceUI(res.newBalance);
        toast(`Забрано ${res.payout} ⭐ (×${res.multiplier.toFixed(2)})`);
        TelegramBridge.haptic('success');
        // active уже false — перерисовываем, чтобы приглушение будущих
        // (не сыгранных) рядов снялось и итоговая доска была видна целиком.
        this.renderTower();
        this.endRound();
      } catch (e) {
        toast(e.message, 'error');
        cashoutBtn.disabled = false;
      } finally {
        this.busy = false;
      }
    },
  };

  $('#btn-towers-start').addEventListener('click', () => Towers.start());
  $('#btn-towers-cashout').addEventListener('click', () => Towers.cashout());
  Towers.renderTower();

  /* ================================ PLINKO ================================ */
  const PLINKO_TABLES = {
    low:    [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high:   [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
  };

  const Plinko = {
    risk: 'medium',
    playing: false,

    // Цвет корзины зависит от того, насколько она "крайняя" (высокий
    // мультипликатор) или "центральная" (низкий) — не от конкретных цифр
    // таблицы, поэтому работает одинаково для low/medium/high риска.
    bucketPalette(distFromCenter, maxDist) {
      const t = maxDist === 0 ? 0 : distFromCenter / maxDist; // 0 центр → 1 край
      const stops = [
        { bg: 'rgba(58,67,88,.35)',  border: 'rgba(120,140,170,.35)', fg: 'rgba(255,255,255,.55)', glow: 'rgba(120,140,170,.5)' },
        { bg: 'rgba(0,217,192,.16)', border: 'rgba(0,217,192,.45)',   fg: '#5ffbe6',               glow: 'rgba(0,217,192,.55)' },
        { bg: 'rgba(255,216,61,.16)',border: 'rgba(255,216,61,.5)',   fg: '#ffd83d',               glow: 'rgba(255,216,61,.55)' },
        { bg: 'rgba(255,157,46,.18)',border: 'rgba(255,157,46,.55)',  fg: '#ff9d2e',               glow: 'rgba(255,157,46,.6)' },
        { bg: 'rgba(255,46,136,.2)', border: 'rgba(255,46,136,.6)',   fg: '#ff2e88',               glow: 'rgba(255,46,136,.65)' },
      ];
      const idx = Math.min(stops.length - 1, Math.round(t * (stops.length - 1)));
      return stops[idx];
    },

    renderBuckets() {
      const el = $('#plinko-buckets');
      el.innerHTML = '';
      const table = PLINKO_TABLES[this.risk];
      const center = (table.length - 1) / 2;
      table.forEach((m, i) => {
        const b = document.createElement('div');
        b.className = 'plinko-bucket';
        b.dataset.idx = i;
        b.textContent = `×${m}`;
        const c = this.bucketPalette(Math.abs(i - center), center);
        b.style.setProperty('--pb-bg', c.bg);
        b.style.setProperty('--pb-border', c.border);
        b.style.setProperty('--pb-fg', c.fg);
        b.style.setProperty('--pb-glow', c.glow);
        el.appendChild(b);
      });
    },

    renderPegs() {
      const board = $('#plinko-board');
      board.innerHTML = '';
      const rows = 8;
      for (let r = 0; r < rows; r++) {
        const rowEl = document.createElement('div');
        rowEl.className = 'plinko-row';
        for (let p = 0; p <= r; p++) {
          const peg = document.createElement('span');
          peg.className = 'plinko-peg';
          rowEl.appendChild(peg);
        }
        board.appendChild(rowEl);
      }
      const ball = document.createElement('div');
      ball.id = 'plinko-ball';
      ball.className = 'plinko-ball';
      ball.style.opacity = '0';
      board.appendChild(ball);
    },

    async play() {
      if (this.playing) return;
      const bet = Number($('#plinko-bet').value);
      this.playing = true;
      const playBtn = $('#btn-plinko-play');
      playBtn.disabled = true;
      document.querySelectorAll('.plinko-bucket').forEach((b) => b.classList.remove('plinko-bucket-hit'));
      try {
        const res = await Api.plinkoPlay(bet, this.risk);
        this.animateBall(res.path, res.bucketIndex, () => {
          window.updateBalanceUI(res.newBalance);
          toast(res.payout >= bet ? `Выигрыш ×${res.multiplier}: +${res.payout} ⭐` : `Мимо: ×${res.multiplier}`, res.payout >= bet ? 'info' : 'error');
          TelegramBridge.haptic(res.payout >= bet ? 'success' : 'error');
          document.querySelector(`.plinko-bucket[data-idx="${res.bucketIndex}"]`)?.classList.add('plinko-bucket-hit');
          this.playing = false;
          playBtn.disabled = false;
        });
      } catch (e) {
        toast(e.message, 'error');
        this.playing = false;
        playBtn.disabled = false;
      }
    },

    // Переписано полностью: раньше шарик двигался с постоянным интервалом
    // (130мс на шаг) — визуально не похоже на падение под гравитацией.
    // Теперь интервал между шагами нарастает (имитация ускорения), плюс
    // на финальном шаге шарик доводится точно до центра выигрышной корзины
    // (см. комментарий ниже) и подпрыгивает при "приземлении".
    animateBall(path, bucketIndex, done) {
      const ball = $('#plinko-ball');
      const board = $('#plinko-board');
      const boardWidth = board.clientWidth || 300;
      const rows = path.length;
      let x = boardWidth / 2;
      let step = 0;
      ball.style.opacity = '1';
      ball.style.left = x + 'px';
      ball.style.top = '0px';
      ball.classList.remove('plinko-ball-landed');

      // Ускорение "под гравитацией": ранние шаги медленнее, поздние быстрее.
      const delayForStep = (s) => Math.round(155 - (s / rows) * 65);

      const step_ = () => {
        if (step >= rows) {
          // БАГ (исправлено): последняя x-координата раньше бралась из
          // накопленной суммы случайных шагов по формуле
          // boardWidth/(rows*2.4), которая никак не связана с реальной
          // пиксельной раскладкой корзин ниже (flex: 1 + gap). Из-за этого
          // шарик визуально часто останавливался не над той корзиной,
          // что подсвечивалась как выигрышная. Теперь на последнем шаге
          // довводим шарик точно к центру настоящей выигрышной корзины.
          const targetBucket = document.querySelector(`.plinko-bucket[data-idx="${bucketIndex}"]`);
          if (targetBucket) {
            const boardRect = board.getBoundingClientRect();
            const bucketRect = targetBucket.getBoundingClientRect();
            x = bucketRect.left - boardRect.left + bucketRect.width / 2;
          }
          ball.style.left = x + 'px';
          ball.style.top = '100%';
          ball.classList.add('plinko-ball-landed');
          setTimeout(done, 380);
          return;
        }
        const dir = path[step] === 'R' ? 1 : -1;
        x += dir * (boardWidth / (rows * 2.4));
        ball.style.left = x + 'px';
        ball.style.top = `${((step + 1) / rows) * 100}%`;
        step++;
        setTimeout(step_, delayForStep(step));
      };
      step_();
    },
  };

  document.querySelectorAll('#plinko-risk-row .mine-count-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#plinko-risk-row .mine-count-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      Plinko.risk = btn.dataset.risk;
      Plinko.renderBuckets();
    });
  });
  $('#btn-plinko-play').addEventListener('click', () => Plinko.play());

  /* ================================ UPGRADE ================================ */
  const Upgrade = {
    chance: 50,
    spinning: false,
    totalRotation: 0,

    multiplierFor(chance) {
      return Math.round((100 / chance) * 0.92 * 100) / 100;
    },

    updateDial() {
      const circumference = 2 * Math.PI * 68;
      const winLen = (this.chance / 100) * circumference;
      $('#upgrade-dial-win').style.strokeDasharray = `${winLen} ${circumference - winLen}`;
      $('#upgrade-dial-lose').style.strokeDasharray = `${circumference} 0`;
      $('#upgrade-mult-display').textContent = `×${this.multiplierFor(this.chance).toFixed(2)}`;
      $('#upgrade-chance-value').textContent = `${this.chance}%`;
      $('#upgrade-chance-slider').value = this.chance;
    },

    setChance(val) {
      this.chance = Math.min(90, Math.max(2, Math.round(val)));
      this.updateDial();
      document.querySelectorAll('#tab-game-upgrade .mine-count-btn[data-chance]').forEach((b) => {
        b.classList.toggle('selected', Number(b.dataset.chance) === this.chance);
      });
    },

    resetResult() {
      $('#upgrade-result').classList.add('hidden');
      $('#upgrade-status-label').textContent = 'Выбери шанс';
    },

    reset() {
      this.spinning = false;
      // Стрелку не дёргаем сюда — иначе при повторном входе на экран видно
      // рывок анимации назад к 0°. Она просто продолжит крутиться от
      // текущего положения при следующем раунде (как и колесо).
      this.resetResult();
      this.updateDial();
    },

    async play() {
      if (this.spinning) return;
      const bet = Number($('#upgrade-bet').value);

      this.spinning = true;
      const playBtn = $('#btn-upgrade-play');
      playBtn.disabled = true;
      $('#upgrade-result').classList.add('hidden');
      $('#upgrade-status-label').textContent = 'Крутим...';

      try {
        const res = await Api.upgradePlay(bet, this.chance);
        const rollAngle = (res.roll / 100) * 360;
        this.totalRotation += 360 * 3 - (this.totalRotation % 360) + rollAngle;
        $('#upgrade-needle').style.transform = `rotate(${this.totalRotation}deg)`;

        setTimeout(() => {
          window.updateBalanceUI(res.newBalance);

          const box = $('#upgrade-result');
          box.classList.remove('hidden');
          if (res.win) {
            $('#upgrade-status-label').textContent = `Победа! (roll ${res.roll})`;
            $('#upgrade-result-title').textContent = `🎉 Выигрыш ×${res.multiplier.toFixed(2)}`;
            $('#upgrade-result-sub').textContent = `Начислено ${res.payoutCoins} ⭐`;
            TelegramBridge.haptic('success');
          } else {
            $('#upgrade-status-label').textContent = `Мимо (roll ${res.roll})`;
            $('#upgrade-result-title').textContent = '💥 Не повезло';
            $('#upgrade-result-sub').textContent = 'Ставка сгорела';
            TelegramBridge.haptic('error');
          }
          this.spinning = false;
          playBtn.disabled = false;
        }, 1750);
      } catch (e) {
        toast(e.message, 'error');
        this.spinning = false;
        playBtn.disabled = false;
        $('#upgrade-status-label').textContent = 'Выбери шанс';
      }
    },
  };

  $('#upgrade-chance-slider').addEventListener('input', (e) => Upgrade.setChance(Number(e.target.value)));
  document.querySelectorAll('#tab-game-upgrade .mine-count-btn[data-chance]').forEach((btn) => {
    btn.addEventListener('click', () => Upgrade.setChance(Number(btn.dataset.chance)));
  });
  $('#btn-upgrade-play').addEventListener('click', () => Upgrade.play());
  Upgrade.updateDial();

  /* ================================ WHEEL ================================ */
  const Wheel = {
    spinning: false,
    segments: null,
    totalRotation: 0,

    buildGradient(segments) {
      const totalWeight = segments.reduce((s, x) => s + x.weight, 0);
      let acc = 0;
      const stops = segments.map((seg) => {
        const start = (acc / totalWeight) * 360;
        acc += seg.weight;
        const end = (acc / totalWeight) * 360;
        return `${seg.color} ${start}deg ${end}deg`;
      });
      return `conic-gradient(${stops.join(', ')})`;
    },

    angleForSegment(segments, index) {
      const totalWeight = segments.reduce((s, x) => s + x.weight, 0);
      let acc = 0;
      for (let i = 0; i < index; i++) acc += segments[i].weight;
      const start = (acc / totalWeight) * 360;
      const end = ((acc + segments[index].weight) / totalWeight) * 360;
      return (start + end) / 2; // середина сектора
    },

    reset() {
      this.spinning = false;
      $('#wheel-result').classList.add('hidden');
      if (!this.segments) {
        // Дефолтная раскраска до первого запроса (совпадает с серверными весами)
        this.segments = [
          { multiplier: 0, weight: 87, color: '#2a2d3d' }, { multiplier: 0.3, weight: 36, color: '#3a4358' },
          { multiplier: 0.5, weight: 32, color: '#3f5c86' }, { multiplier: 1, weight: 28, color: '#1f8fd6' },
          { multiplier: 1.5, weight: 20, color: '#1fb894' }, { multiplier: 2, weight: 16, color: '#2fe08a' },
          { multiplier: 3, weight: 10, color: '#ffd83d' }, { multiplier: 5, weight: 6, color: '#ff9d2e' },
          { multiplier: 10, weight: 3, color: '#ff2e88' }, { multiplier: 20, weight: 1, color: '#b026ff' },
        ];
        $('#wheel-disc').style.background = this.buildGradient(this.segments);
      }
    },

    async play() {
      if (this.spinning) return;
      const bet = Number($('#wheel-bet').value);
      this.spinning = true;
      const playBtn = $('#btn-wheel-play');
      playBtn.disabled = true;
      $('#wheel-result').classList.add('hidden');

      try {
        const res = await Api.wheelPlay(bet);
        this.segments = res.segments;
        $('#wheel-disc').style.background = this.buildGradient(this.segments);

        // Указатель сверху = 0deg. Крутим колесо так, чтобы нужный сектор оказался под ним.
        const segAngle = this.angleForSegment(this.segments, res.segmentIndex);
        this.totalRotation += 360 * 4 - (this.totalRotation % 360) - segAngle + 360;
        $('#wheel-disc').style.transform = `rotate(${this.totalRotation}deg)`;

        setTimeout(() => {
          window.updateBalanceUI(res.newBalance);
          const box = $('#wheel-result');
          box.classList.remove('hidden');
          if (res.payout >= bet) {
            $('#wheel-result-title').textContent = `🎉 ×${res.multiplier} — выигрыш!`;
            $('#wheel-result-sub').textContent = `Начислено ${res.payout} ⭐`;
            TelegramBridge.haptic('success');
          } else {
            $('#wheel-result-title').textContent = `×${res.multiplier}`;
            $('#wheel-result-sub').textContent = res.payout > 0 ? `Вернулось ${res.payout} ⭐` : 'Пусто в этот раз';
            TelegramBridge.haptic('error');
          }
          this.spinning = false;
          playBtn.disabled = false;
        }, 3500);
      } catch (e) {
        toast(e.message, 'error');
        this.spinning = false;
        playBtn.disabled = false;
      }
    },
  };

  $('#btn-wheel-play').addEventListener('click', () => Wheel.play());
  Wheel.reset();

  /* ================================ ROUTER ================================ */
  window.Games = {
    onOpen(game) {
      if (game === 'crash') Crash.resume();
      if (game === 'mines') Mines.resume();
      if (game === 'towers') Towers.resume();
      if (game === 'plinko') { Plinko.renderBuckets(); Plinko.renderPegs(); }
      if (game === 'upgrade') Upgrade.reset();
      if (game === 'wheel') Wheel.reset();
    },
    onLeave() {
      Crash.stop();
    },
  };
})();
