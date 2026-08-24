# Архитектура

Карта кода: где что лежит, как данные ходят между слоями и почему сделано
именно так. Читается вторым файлом после `AGENTS.md`.

---

## 1. Стек и версии

| Слой         | Технологии                                                        |
| ------------ | ----------------------------------------------------------------- |
| Frontend     | React 19, Vite 8, TypeScript 5.9, TanStack Query 5, Zustand 5      |
| Backend      | Node ≥ 20.11 (в CI и на VPS — 22), Fastify 5, Prisma 7, grammY 1   |
| Контракт     | zod 4 в `packages/shared`                                         |
| БД           | SQLite через `@prisma/adapter-better-sqlite3` (готова к Postgres)  |
| Оплата       | Telegram Stars (XTR); провайдер (RUB/USD) подключается конфигом    |
| Прод         | Ubuntu VPS, Caddy, systemd, GitHub Actions                        |

Модульная система — ESM везде (`"type": "module"` во всех package.json).

---

## 2. Дерево каталогов

```
packages/shared/src/         единый контракт (zod-схемы + типы + чистые функции)
  money.ts                   валюты, minor units, formatMoney
  catalog.ts                 Category, Product, ProductListItem, FulfillmentKind
  order.ts                   Order, OrderLine, статусы, входные схемы корзины
  telegram.ts                initData, TelegramUser, Viewer
  errors.ts                  API_ERROR_CODES + HTTP_STATUS_BY_CODE
  index.ts                   реэкспорт всего

apps/api/
  prisma/schema.prisma       модели БД
  prisma/seed.ts             демо-каталог, идемпотентный
  prisma.config.ts           конфиг Prisma 7 CLI (адаптер + путь к базе)
  scripts/webhook.ts         set/delete вебхука Telegram
  src/
    config.ts                разбор env через zod + проверки безопасности прода
    db.ts                    единственный PrismaClient
    errors.ts                AppError и хелперы (notFound, validationError…)
    server.ts                сборка Fastify: CORS, rate limit, обработка ошибок
    plugins/auth.ts          проверка initData → Viewer (requireViewer/requireAdmin)
    routes/catalog.ts        GET /api/categories, /api/products, /api/products/:slug
    routes/orders.ts         GET|POST /api/orders, /api/me, /api/orders/:id/cancel
    routes/bot.ts            POST /telegram/webhook + обработчики grammY
    services/catalog.ts      чтение каталога, подсчёт остатка
    services/orders.ts       создание заказа, выдача товара, идемпотентность
    payments/gateway.ts      абстракция оплаты (Stars | provider | none)
    telegram/bot.ts          единственный инстанс grammY Bot (или null)
    telegram/init-data.ts    HMAC-проверка подписи Telegram
    generated/prisma/        вывод prisma generate — НЕ РЕДАКТИРОВАТЬ

apps/miniapp/src/
  main.tsx                   точка входа: тема, WebApp.ready, QueryClient
  App.tsx                    стек экранов + нижний TabBar
  api/client.ts              типизированный fetch-клиент, ApiError
  screens/                   CatalogScreen, ProductScreen, CartScreen, OrdersScreen
  components/ui.tsx          Price, Stepper, Spinner, ProductSkeletonGrid, EmptyState, ErrorState
  store/cart.ts              Zustand-корзина с persist в localStorage
  telegram/webapp.ts         типизированная обёртка window.Telegram.WebApp
  telegram/buttons.ts        useMainButton, useBackButton
  telegram/theme.ts          проброс themeParams в CSS-переменные
  styles.css                 глобальные стили на CSS-переменных Telegram

deploy/                      Caddyfile, systemd unit, setup-server.sh, deploy.sh,
                             pack-artifact.mjs (сборка артефакта для сервера)
.github/workflows/deploy.yml CI: install (собирает shared) → typecheck → test →
                             build → pack → scp → install
```

---

## 3. Ключевой поток: покупка

```
Mini App                     API                          Telegram
   |                          |                              |
   |-- POST /api/orders ----->|                              |
   |   {items:[{productId,    | 1. requireViewer: HMAC initData
   |            quantity}]}   | 2. цены из БД, проверка остатка
   |                          | 3. Order(PENDING) + OrderLine (снапшоты)
   |                          |-- createInvoiceLink -------->|
   |<-- 201 {order, invoiceUrl}                              |
   |                                                         |
   |-- WebApp.openInvoice(invoiceUrl) ---------------------->|
   |                          |                              |
   |                          |<-- pre_checkout_query -------|
   |                          |   проверка суммы и статуса   |
   |                          |-- answerPreCheckoutQuery --->|  (≤ 10 сек!)
   |                          |                              |
   |                          |<-- message.successful_payment|
   |                          | markOrderPaid():             |
   |                          |   claimLicenseKey (условный UPDATE)
   |                          |   status = PAID | FAILED     |
   |                          |-- reply с ключом ----------->|
   |<-- callback('paid') ------------------------------------|
   |   clear() + invalidate ['orders'],['products']          |
```

Важные точки:

- **Товар выдаёт бот из вебхука, а не фронт.** Если пользователь закроет
  приложение сразу после оплаты, ключ всё равно придёт в чат.
- `pre_checkout_query` — последний шанс отказать до списания. Ответ обязан
  уйти в течение 10 секунд, поэтому там нет тяжёлых операций.
- Бесплатный заказ (`totalAmountMinor === 0`) выдаётся сразу в `createOrder`,
  без Telegram и без вебхука. Удобно для проверки стенда.
- `update_id` каждого апдейта пишется в `ProcessedUpdate` **до** передачи
  в grammY — повторная доставка отбрасывается на входе.

---

## 4. Аутентификация

```
Клиент:  Authorization: tma <initData>        (альтернатива: x-telegram-init-data)
Сервер:  verifyInitData() → upsertUser() → request.viewer: Viewer
```

- `secret_key = HMAC_SHA256("WebAppData", botToken)`,
  `hash = HMAC_SHA256(secret_key, data_check_string)`.
- В `data_check_string` попадают все поля, кроме `hash`; **`signature`
  включается**.
- Сравнение хешей — `timingSafeEqual`, подпись проверяется **до** доверия
  любому полю, включая `auth_date`.
- `isAdmin` вычисляется из `ADMIN_TELEGRAM_IDS` при каждом входе, поэтому
  права выдаются и отзываются без правки БД.
- Dev-обход: заголовок `x-dev-telegram-id` работает только при
  `ALLOW_DEV_AUTH=true`, и `config.ts` запрещает этот флаг в production.

Каталог публичный (`/api/categories`, `/api/products`) — просмотр не требует
подписи. Всё, что связано с заказами, требует `requireViewer`.

---

## 5. Модель данных

```
User 1---* Order 1---* OrderLine *---1 Product *---1 Category
                            |                |
                            |                *--- LicenseKey (склад)
                            *--- LicenseKey (выданные ключи)

ProcessedUpdate — только update_id + createdAt (защита от повторов)
```

| Модель            | Зачем и что важно                                                |
| ----------------- | ---------------------------------------------------------------- |
| `User`            | `telegramId` — **String**: id не влезает в 2^53                   |
| `Category`        | slug, сортировка, emoji                                          |
| `Product`         | цена в minor units, `fulfillmentKind`, `staticPayload` (секрет)   |
| `LicenseKey`      | одна строка = одна единица склада; `claimedAt` + `orderLineId`    |
| `Order`           | `reference` для человека, `invoicePayload` (уникален) для Telegram |
| `OrderLine`       | снапшоты `titleSnapshot`/`unitAmountMinor`; `deliveredPayload`     |
| `ProcessedUpdate` | идемпотентность вебхуков                                          |

Строковые «enum'ы» (`status`, `fulfillmentKind`, `currency`) специально не
Prisma-enum: так схема одинаково работает на SQLite и Postgres, а валидация
живёт в zod.

Статусы заказа: `PENDING → PAID` (норма), `CANCELLED` (до оплаты),
`REFUNDED` (возврат Stars), `FAILED` — **оплата прошла, выдать не удалось**;
требует ручного разбора.

---

## 6. Эндпоинты

| Метод | Путь                      | Авторизация    | Назначение                       |
| ----- | ------------------------- | -------------- | -------------------------------- |
| GET   | `/health`                 | нет            | проверка живости + конфиг        |
| GET   | `/api/categories`         | нет            | список категорий                 |
| GET   | `/api/products`           | нет            | каталог, фильтры `category`, `q` |
| GET   | `/api/products/:slug`     | нет            | карточка товара                  |
| GET   | `/api/me`                 | initData       | текущий пользователь             |
| GET   | `/api/orders`             | initData       | свои заказы (до 50)              |
| GET   | `/api/orders/:id`         | initData       | свой заказ, иначе 404            |
| POST  | `/api/orders`             | initData       | создать заказ + инвойс (20/мин)  |
| POST  | `/api/orders/:id/cancel`  | initData       | отменить `PENDING`               |
| POST  | `/telegram/webhook`        | secret token   | апдейты Telegram                 |

Общий rate limit — 300 запросов в минуту; вебхук из него исключён.
Формат ошибки всегда: `{ error: { code, message, details? } }`.

---

## 7. Frontend: как устроено

- **Навигация** — массив `View[]` в `App.tsx` (`push`/`pop`/`resetTo`), без
  react-router. Причина: Telegram BackButton должен точно повторять глубину
  стека, а history API внутри WebView ведёт себя непредсказуемо.
- **Основное действие** экрана — нативная `MainButton` (`useMainButton`).
  Пока запрос в полёте, кнопка в состоянии `showProgress(false)` — это и есть
  защита от двойного оформления заказа.
- **Серверные данные** — TanStack Query, ключи `['products', category]`,
  `['product', slug]`, `['categories']`, `['orders']`. 4xx не ретраятся.
  Экран заказов сам опрашивает сервер каждые 3 сек, пока есть `PENDING`.
- **Клиентское состояние** — Zustand + persist (`shop-cart-v1`). Цена в
  корзине только для показа; сервер всё пересчитывает.
- **Тема** — `themeParams` Telegram проецируются в CSS-переменные
  (`--tg-bg-color` и т.д.), поэтому приложение выглядит родным в любой теме.
- Вне Telegram приложение работает и показывает баннер: оплата недоступна,
  вход — только dev-режим.

---

## 8. Конфигурация

Читается один раз в `apps/api/src/config.ts` (zod, падает при старте).

| Переменная                  | Смысл                                                |
| --------------------------- | ---------------------------------------------------- |
| `DATABASE_URL`              | путь к SQLite; относительный — от `apps/api`          |
| `TELEGRAM_BOT_TOKEN`        | ключ подписи initData; обязателен в prod              |
| `TELEGRAM_WEBHOOK_SECRET`   | проверка вебхука; обязателен в prod                   |
| `TELEGRAM_PROVIDER_TOKEN`   | только для `PAYMENT_PROVIDER="provider"`              |
| `TELEGRAM_API_ROOT`         | подмена Bot API; используется в тестах                |
| `PUBLIC_API_URL`            | публичный HTTPS-origin API (регистрация вебхука)      |
| `PAYMENT_PROVIDER`          | `stars` \| `provider` \| `none`                      |
| `CORS_ORIGINS`              | пусто → только `*.telegram.org` и localhost           |
| `ADMIN_TELEGRAM_IDS`        | список id администраторов                             |
| `INIT_DATA_MAX_AGE_SECONDS` | срок жизни initData, по умолчанию сутки               |
| `ALLOW_DEV_AUTH`            | dev-обход подписи; **в prod вызывает падение старта**  |

Фронтенд: `VITE_API_URL` (пусто = same-origin через прокси Vite),
`VITE_API_PROXY_TARGET`, `VITE_DEV_TELEGRAM_ID` (вырезается из prod-бандла
через `import.meta.env.DEV`).

---

## 9. Тесты

32 теста, чистый `node:test` через `tsx`, без Jest/Vitest.

| Файл                                     | Что проверяет                                     |
| ---------------------------------------- | ------------------------------------------------- |
| `apps/api/src/telegram/init-data.test.ts` | 14 тестов подписи: подмена, `signature`, срок, порядок |
| `apps/api/src/server.test.ts`             | 18 e2e через `app.inject()` на временной SQLite    |

Покрыты именно инварианты: цена не берётся с клиента, чужой заказ → 404,
перепродажа ключей невозможна, повтор платежа не выдаёт второй ключ,
`staticPayload` не утекает в ответ.

Тесты поднимают схему `prisma db push` в `os.tmpdir()` и удаляют её после
прогона. `TELEGRAM_API_ROOT` указывает в `127.0.0.1:9`, поэтому сеть не
задействуется.

---

## 10. Таблица «задача → файлы»

Открывай только перечисленное, остальное не нужно.

| Задача                             | Файлы                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------- |
| Новое поле у товара                | `prisma/schema.prisma` → `shared/src/catalog.ts` → `services/catalog.ts` → `screens/ProductScreen.tsx` |
| Новый эндпоинт                     | `routes/*.ts` + `services/*.ts` + схема в `shared` + тест в `server.test.ts` |
| Логика заказа / выдачи             | `services/orders.ts`, `routes/bot.ts`                                   |
| Оплата, валюты, провайдер          | `payments/gateway.ts`, `shared/src/money.ts`, `config.ts`               |
| Аутентификация, initData           | `plugins/auth.ts`, `telegram/init-data.ts`                              |
| Новый код ошибки                   | `shared/src/errors.ts` → `apps/api/src/errors.ts`                       |
| Экран или UI                       | `screens/*.tsx`, `components/ui.tsx`, `styles.css`                       |
| Корзина                            | `store/cart.ts`, `screens/CartScreen.tsx`                               |
| Вызовы Telegram WebApp             | `telegram/webapp.ts`, `telegram/buttons.ts`                             |
| Сообщения и команды бота           | `routes/bot.ts`                                                         |
| Переменные окружения               | `config.ts`, `apps/api/.env.example`, `deploy/setup-server.sh`           |
| Деплой, Caddy, systemd             | `deploy/*`, `.github/workflows/deploy.yml`, `docs/DEPLOYMENT.md`         |
| Состав артефакта для сервера       | `deploy/pack-artifact.mjs`                                              |
| Демо-данные                        | `apps/api/prisma/seed.ts`                                               |

---

## 11. Принятые решения и их причины

| Решение                              | Почему так                                                     |
| ------------------------------------ | -------------------------------------------------------------- |
| Монорепо с `packages/shared`         | одна форма данных на фронт и бэк; расхождение ловит typecheck    |
| Склад = строки `LicenseKey`          | условный `UPDATE` делает перепродажу физически невозможной       |
| Снапшоты в `OrderLine`               | старый заказ читается верно после изменения цены товара          |
| Прокси Vite `/api`                   | same-origin: нет CORS, одного туннеля хватает на фронт и API      |
| Стек экранов вместо роутера          | синхронность с Telegram BackButton внутри WebView                |
| SQLite через driver adapter          | нулевая настройка в dev; переход на Postgres = смена адаптера     |
| `AppError` + `HTTP_STATUS_BY_CODE`   | статус нельзя забыть или указать неверно                         |
| Статусы строками, а не Prisma enum   | одинаковое поведение SQLite и Postgres                           |
| `node:test` вместо Jest              | ноль зависимостей и конфигурации, тесты запускаются как есть      |
| Релизы + симлинк `current`           | сломанная сборка не трогает работающий сайт, откат мгновенный     |
| Сборка в CI, на сервер — артефакт    | VPS слабый: `tsc`+`vite` там грозят OOM. Runner бесплатный        |
| `node_modules` ставит сервер         | нативный SQLite привязан к ABI Node; локальная установка исключает несовместимость |

---

## 12. Что не сделано

Известные пробелы (актуально на 2026-08-23):

- Админки нет: товары и ключи заливаются через `prisma/seed.ts` или Studio.
- Загрузки изображений нет — `imageUrl` заполняется вручную.
- Возврат Stars (`refundStarPayment`) обрабатывается только на входящем
  событии; инициировать возврат из интерфейса нельзя.
- Заказы в статусе `FAILED` никак не мониторятся, только видны в БД и в UI.
- Миграции Prisma не ведутся, используется `db push`.
- Автобэкапов SQLite нет.
