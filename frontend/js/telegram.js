/**
 * Обёртка над Telegram WebApp SDK.
 * Документация: https://core.telegram.org/bots/webapps
 */
const TG = window.Telegram?.WebApp;

const TelegramBridge = {
  init() {
    if (!TG) {
      console.warn('Telegram WebApp SDK недоступен — запуск вне Telegram (dev-режим)');
      return;
    }
    TG.ready();
    TG.expand();
    // Тёмная киберпанк-тема — задаём цвет шапки/фона под наш дизайн
    TG.setHeaderColor('#0a0a12');
    TG.setBackgroundColor('#0a0a12');
    TG.enableClosingConfirmation();
  },

  /** initData строка для передачи на бэкенд в заголовке X-Telegram-Init-Data */
  getInitData() {
    return TG?.initData || '';
  },

  /** Данные пользователя из initDataUnsafe (только для UI, не для доверенной логики!) */
  getUser() {
    return TG?.initDataUnsafe?.user || { id: 1000001, first_name: 'DevUser', username: 'dev_user' };
  },

  haptic(type = 'light') {
    if (!TG?.HapticFeedback) return;
    if (type === 'success' || type === 'error' || type === 'warning') {
      TG.HapticFeedback.notificationOccurred(type);
    } else {
      TG.HapticFeedback.impactOccurred(type);
    }
  },

  mainButton: {
    show(text, onClick) {
      if (!TG?.MainButton) return;
      TG.MainButton.setText(text);
      TG.MainButton.onClick(onClick);
      TG.MainButton.show();
    },
    hide() { TG?.MainButton?.hide(); },
  },

  /**
   * Открытие реального Stars Invoice (когда бэкенд отдаёт invoiceLink,
   * созданный через Bot API createInvoiceLink с currency: "XTR").
   * В демо-режиме (mock) эта функция не используется — см. app.js -> mockTopUp().
   */
  openInvoice(invoiceLink, callback) {
    if (!TG?.openInvoice) {
      console.warn('openInvoice недоступен в текущем окружении');
      callback?.('not_supported');
      return;
    }
    TG.openInvoice(invoiceLink, (status) => callback?.(status));
  },

  close() { TG?.close(); },
};

TelegramBridge.init();
