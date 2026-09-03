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
  pricing.ts                 клубный тариф: standardUnitMinor, cartTotals
  catalog.ts                 Category, Product, ProductListItem, FulfillmentKind
  order.ts                   Order, OrderLine, статусы, входные схемы корзины
  telegram.ts                initData, TelegramUser, Viewer, UserRole, Permission
  admin.ts                   входные схемы управления: категории, товары, персонал
  errors.ts                  API_ERROR_CODES + HTTP_STATUS_BY_CODE
  index.ts                   реэкспорт всего

apps/api/
  prisma/schema.prisma       модели БД
  prisma.config.ts           конфиг Prisma 7 CLI (адаптер + путь к базе)
  src/
    config.ts                разбор env через zod + проверки безопасности прода
    db.ts                    единственный PrismaClient
    errors.ts                AppError и хелперы (notFound, validationError…)
    server.ts                сборка Fastify: CORS, rate limit, обработка ошибок
    cli/seed.ts              демо-каталог, идемпотентный
    cli/webhook.ts           set/delete вебхука Telegram
    plugins/auth.ts          проверка initData → Viewer; RBAC: requireRole/requirePermission
    routes/catalog.ts        GET /api/categories, /api/products, /api/products/:slug
    routes/orders.ts         GET|POST /api/orders, /api/orders/:id/cancel
    routes/users.ts          GET /api/me — профиль, роль и права вызывающего
    routes/admin.ts          управляющие роуты: каталог, товары, заказы, персонал
    routes/bot.ts            POST /telegram/webhook + обработчики grammY
    services/catalog.ts      чтение каталога, подсчёт остатка
    services/admin-catalog.ts запись каталога: категории, товары, ключи
    services/admin-orders.ts глобальный список заказов (VIEW_ORDERS)
    services/managers.ts     назначение менеджеров и выдача прав
    services/orders.ts       создание заказа, выдача товара, идемпотентность
    payments/gateway.ts      абстракция оплаты (Stars | provider | none)
    telegram/bot.ts          единственный инстанс grammY Bot (или null)
    telegram/init-data.ts    HMAC-проверка подписи Telegram
    generated/prisma/        вывод prisma generate — НЕ РЕДАКТИРОВАТЬ

apps/miniapp/src/
  main.tsx                   точка входа: тема, WebApp.ready, QueryClient
  App.tsx                    стек экранов + выбор активной вкладки
  api/client.ts              типизированный fetch-клиент, ApiError
  api/useViewer.ts           единственный запрос ['me'] на всё приложение
  screens/                   CatalogScreen (главная), ProductScreen, CartScreen,
                             OrdersScreen, ProfileScreen
  components/AppLayout.tsx   корневой каркас: шапка профиля + нижняя навигация
  components/ui.tsx          Price, Stepper, Spinner, скелетоны, EmptyState,
                             ErrorState, ClubTierNotice, ClubChannelButton
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
- Роль и права приходят из БД тем же запросом, что и upsert пользователя,
  так что `Viewer` всегда содержит актуальные `role` и `permissions`.
- `isAdmin` в ответе — зеркало `role === 'ADMIN'`, оставлено для совместимости
  с существующими клиентами. **Проверки доступа читают `role`.**
- Dev-обход: заголовок `x-dev-telegram-id` работает только при
  `ALLOW_DEV_AUTH=true`, и `config.ts` запрещает этот флаг в production.

Каталог публичный (`/api/categories`, `/api/products`) — просмотр не требует
подписи. Всё, что связано с заказами, требует `requireViewer`.

### RBAC

```
app.get('/admin/x',  { preHandler: app.requireRole('ADMIN') },               handler)
app.get('/manage/y', { preHandler: app.requirePermission('EDIT_CATALOG') },  handler)
```

- `requireRole(...roles)` пропускает вызывающего, если его роль есть в списке.
- `requirePermission(permission)` требует право из `permissionSchema`
  (`packages/shared/src/telegram.ts`). Аргумент проверяется **при регистрации
  роута**: опечатка `EDIT_CATALGO` роняет старт сервера, а не превращается в
  вечный 403, неотличимый от честного отказа.
- `ADMIN` проходит `requirePermission` всегда — иначе администратору нужно
  было бы выдавать каждое право поимённо, и добавление нового права ломало бы
  ему доступ.
- Право учитывается только у роли `MANAGER`. Понижение до `USER` отзывает
  доступ даже если строки в `ManagerPermission` остались.
- Неизвестные строки прав из БД отбрасываются в `Viewer`: право, удалённое из
  кода, перестаёт действовать сразу, а не «протекает» как нераспознанное.
- `requireAdmin` — это `requireRole('ADMIN')`.
- Все три возвращают `Viewer` и кладут его в `request.viewer`, поэтому
  повторный `requireViewer` в обработчике не ходит в БД второй раз.

### Роль ADMIN: единственный источник — `ADMIN_TELEGRAM_IDS`

Инвариант: **права администратора выдаются и отзываются правкой env, без
доступа к базе.** Работает в обе стороны, на каждом входе:

| В `ADMIN_TELEGRAM_IDS` | `role` в БД | Результат              |
| ---------------------- | ----------- | ---------------------- |
| да                     | любая       | повышается до `ADMIN`  |
| нет                    | `ADMIN`     | **понижается до `USER`** |
| нет                    | `MANAGER`   | остаётся `MANAGER`     |

Половина «понижение» критична: без неё удаление id из конфига оставляло бы в
таблице запись `ADMIN`, и отобрать доступ можно было бы только руками в БД —
ровно то, от чего конфиг и должен избавлять. Роль `ADMIN`, выставленная в базе
напрямую, сбрасывается при первом же входе.

`MANAGER` назначается в базе и конфигом не управляется: его полномочия задают
строки `ManagerPermission`, а не env.

Покрыто тестами в `apps/api/src/plugins/auth.test.ts`.

---

## 5. Модель данных

```
User 1---* Order 1---* OrderLine *---1 Product *---1 Category
  |                         |                |
  |                         |                *--- LicenseKey (склад)
  |                         *--- LicenseKey (выданные ключи)
  *---* ManagerPermission (по одной строке на право)

ProcessedUpdate — только update_id + createdAt (защита от повторов)
```

| Модель            | Зачем и что важно                                                |
| ----------------- | ---------------------------------------------------------------- |
| `User`            | `telegramId` — **String**: id не влезает в 2^53; `role` строкой, но для `ADMIN` источник истины — env, не БД |
| `ManagerPermission` | одно право = одна строка; уникальна в паре `userId` + `permission` |
| `Category`        | slug, сортировка, emoji                                          |
| `Product`         | цена в minor units, `fulfillmentKind`, `staticPayload` (секрет)   |
| `LicenseKey`      | одна строка = одна единица склада; `claimedAt` + `orderLineId`    |
| `Order`           | `reference` для человека, `invoicePayload` (уникален) для Telegram |
| `OrderLine`       | снапшоты `titleSnapshot`/`unitAmountMinor`; `deliveredPayload`     |
| `ProcessedUpdate` | идемпотентность вебхуков                                          |

Строковые «enum'ы» (`status`, `fulfillmentKind`, `currency`, `role`,
`permission`) специально не Prisma-enum: так схема одинаково работает на SQLite
и Postgres, а валидация живёт в zod.

Роли: `USER` (по умолчанию, обычный покупатель), `MANAGER` (только явно
выданные права) и `ADMIN` (полный доступ). `role` в БД для `ADMIN` — это
кеш решения, принятого по `ADMIN_TELEGRAM_IDS`, а не самостоятельный источник:
см. раздел 4.

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
| GET   | `/api/me`                 | initData       | профиль: имя, роль, права, клубный статус |
| GET   | `/api/orders`             | initData       | свои заказы (до 50)              |
| GET   | `/api/orders/:id`         | initData       | свой заказ, иначе 404            |
| POST  | `/api/orders`             | initData       | создать заказ + инвойс (20/мин)  |
| POST  | `/api/orders/:id/cancel`  | initData       | отменить `PENDING`               |
| POST  | `/api/categories`         | `EDIT_CATALOG` | создать категорию                |
| PUT   | `/api/categories/:id`     | `EDIT_CATALOG` | изменить категорию (частично)    |
| DELETE| `/api/categories/:id`     | `EDIT_CATALOG` | удалить; товары остаются         |
| POST  | `/api/products`           | `MANAGE_KEYS`  | создать товар + залить ключи     |
| PUT   | `/api/products/:id`       | `MANAGE_KEYS`  | изменить товар, добавить ключи   |
| DELETE| `/api/products/:id`       | `MANAGE_KEYS`  | деактивировать (не удалять)      |
| GET   | `/api/orders/all`         | `VIEW_ORDERS`  | все заказы + покупатель          |
| GET   | `/api/managers`           | `MANAGE_MANAGERS` | персонал и их права           |
| POST  | `/api/managers`           | `MANAGE_MANAGERS` | назначить менеджера, задать права |
| DELETE| `/api/managers/:telegramId` | `MANAGE_MANAGERS` | снять менеджера → `USER`    |
| POST  | `/telegram/webhook`        | secret token   | апдейты Telegram                 |

Права в колонке «Авторизация» — это `requirePermission(...)`; роль `ADMIN`
проходит их все без явной выдачи. Управляющие роуты живут под тем же префиксом
`/api`, что и публичные: отличает их pre-handler, а не участок URL — иначе
отсутствие сегмента `/admin` можно было бы принять за признак публичности.

`/api/orders/all` не конфликтует с `/api/orders/:id`: radix-роутер Fastify
предпочитает статический сегмент параметрическому независимо от порядка
регистрации. Это закреплено тестом — коллизия превратила бы чужой заказ
покупателя в ошибку прав.

Общий rate limit — 300 запросов в минуту; вебхук из него исключён.
Формат ошибки всегда: `{ error: { code, message, details? } }`.

---

## 7. Frontend: как устроено

- **Корневой каркас** — `AppLayout` (`components/AppLayout.tsx`): шапка профиля
  сверху, нижняя панель навигации снизу, экран между ними. Обе панели живут в
  обёртке, а не в экранах, поэтому рендерятся один раз и не перемонтируются при
  навигации: перемонтирование панели теряет тап, который эту навигацию вызвал.
  Шапка видна на основных экранах (Каталог, Корзина, Заказы) и скрыта на
  вложенных (товар, профиль) — там работает `BackButton`.
- **Навигация** — массив `View[]` в `App.tsx` (`push`/`pop`/`resetTo`), без
  react-router. Причина: Telegram BackButton должен точно повторять глубину
  стека, а history API внутри WebView ведёт себя непредсказуемо. Выбор вкладки
  всегда делает `resetTo`, поэтому любая вкладка — валидный выход из профиля и
  из карточки товара без отдельной ветки на экран.
- **Активная вкладка** для вложенного экрана — родительская (`tabForView`):
  товар подсвечивает «Каталог», профиль — ту вкладку, из которой открыт.
  Неподсвеченная панель читается как «вы нигде».
- **Основное действие** экрана — нативная `MainButton` (`useMainButton`).
  Пока запрос в полёте, кнопка в состоянии `showProgress(false)` — это и есть
  защита от двойного оформления заказа.
- **Серверные данные** — TanStack Query, ключи `['me']`, `['products', category]`,
  `['product', slug]`, `['categories']`, `['orders']`. 4xx не ретраятся.
  Экран заказов сам опрашивает сервер каждые 3 сек, пока есть `PENDING`.
- **Профиль загружается один раз на всё приложение** — хук `useViewer`
  (`api/useViewer.ts`) с ключом `['me']`. Его читают шапка, карточка товара и
  корзина: два независимых запроса возвращались бы в разное время, и клубный
  статус в шапке мог бы расходиться с плашкой над кнопкой.
- **Профиль не обязателен для просмотра.** Запрос `['me']` идёт с `retry: false`
  и при неудаче даёт нейтральное «Привет» вместо ошибки: вне Telegram это
  гарантированный 401, а каталог публичный и должен работать всё равно.
  Отсутствие профиля означает просто «клубного тарифа нет».
- **Скелетоны совпадают по размеру с контентом**, который заменяют (шапка
  профиля, `CategorySkeletonGrid`). Иначе шапка прыгает в момент прихода имени —
  именно это выдаёт в Mini App веб-страницу.
- **Клиентское состояние** — Zustand + persist (`shop-cart-v1`). Цена в
  корзине только для показа; сервер всё пересчитывает.
- **Тема** — `themeParams` Telegram проецируются в CSS-переменные
  (`--tg-bg-color` и т.д.), поэтому приложение выглядит родным в любой теме.
- Вне Telegram приложение работает и показывает баннер: оплата недоступна,
  вход — только dev-режим.

### Клубный тариф

Значение цены в БД — это **клубный тариф** `P`: столько платит подписчик канала.
Стандартная цена выводится как `L = round(P / 0.95)`.

- Математика — `packages/shared/src/pricing.ts`, один модуль на оба конца:
  `standardUnitMinor`, `effectiveUnitMinor`, `tierAdjustmentMinor`, `cartTotals`.
- `L = P / 0.95`, а не `P × 1.05`: утрата тарифа стоит ~5.26%, не 5%.
  Перевёрнутое направление занижает выгоду подписки и выглядит правдоподобно,
  поэтому закреплено тестом.
- Только целые числа: `amount × 10000 / 9500` вместо `amount / 0.95`.
  Округление **на единицу**, а не на строку — сервер хранит `unitAmountMinor` и
  умножает на количество.
- Флаг `Viewer.isSubscribedChannel` приходит только с сервера. Проверка
  `getChatMember` пока не подключена, сервер отдаёт `false` (`plugins/auth.ts`):
  источник значения уже единственный, включение проверки меняет способ
  вычисления, а не место.
- В UI: витрина показывает цены штатно и одинаково для всех, без перечёркиваний
  (сетка зачёркнутых чисел читается как распродажа, а тариф — постоянная
  ставка). Плашки `ClubTierNotice` — на карточке товара над кнопкой действия и в
  корзине; в корзине показаны оба состояния, на карточке — только приглашение.

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
`VITE_API_PROXY_TARGET`, `VITE_CLUB_CHANNEL_URL` (пусто скрывает все точки
перехода в канал), `VITE_DEV_TELEGRAM_ID` (вырезается из prod-бандла через
`import.meta.env.DEV`).

---

## 9. Тесты

113 тестов, чистый `node:test` через `tsx`, без Jest/Vitest.

| Файл                                     | Что проверяет                                     |
| ---------------------------------------- | ------------------------------------------------- |
| `apps/api/src/telegram/init-data.test.ts` | 14 тестов подписи: подмена, `signature`, срок, порядок |
| `apps/api/src/server.test.ts`             | 19 e2e через `app.inject()` на временной SQLite    |
| `apps/api/src/plugins/auth.test.ts`       | 15 тестов авторизации: роли, права, инвариант `ADMIN_TELEGRAM_IDS` |
| `apps/api/src/routes/admin.test.ts`       | 55 тестов управления: 30 на защиту каждого роута, остальные на CRUD |
| `apps/api/src/pricing.test.ts`            | 10 тестов клубного тарифа: направление `P / 0.95`, целые числа, округление на единицу |

Покрыты именно инварианты: цена не берётся с клиента, чужой заказ → 404,
перепродажа ключей невозможна, повтор платежа не выдаёт второй ключ,
`staticPayload` не утекает в ответ, роль `ADMIN` понижается после удаления id
из конфига, понижённый менеджер теряет доступ вместе с ролью, частичный `PUT`
не затирает поля, которых не было в запросе.

`pricing.test.ts` лежит в workspace API, потому что там запускается тест-раннер:
добавлять `tsx` в `packages/shared` ради этих тестов — новая зависимость без
выгоды. Проверяемый код общий, а списывать деньги по нему будет именно API.

В `admin.test.ts` защита проверяется таблицей: для **каждого** управляющего
роута — 401 без подписи, 403 для покупателя и 403 для менеджера с *другим*
правом. Так пропущенный pre-handler виден сразу; проверено мутацией — снятие
одного guard'а роняет 3 теста.

Тесты поднимают схему `prisma db push` в `os.tmpdir()` и удаляют её после
прогона. `TELEGRAM_API_ROOT` указывает в `127.0.0.1:9`, поэтому сеть не
задействуется. `auth.test.ts` поднимает **свой** инстанс Fastify с
одноразовыми роутами под каждый guard: так поведение проверок зафиксировано
независимо от того, какие роуты их используют.

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
| Роли и права (RBAC)                | `prisma/schema.prisma` → `shared/src/telegram.ts` → `plugins/auth.ts` → тест в `plugins/auth.test.ts` |
| Новое право менеджера              | `permissionSchema` в `shared/src/telegram.ts`, затем `requirePermission('…')` на роуте |
| Управляющий эндпоинт               | `shared/src/admin.ts` → `services/admin-*.ts` или `services/managers.ts` → `routes/admin.ts` → строка в таблице `ACCESS` (`routes/admin.test.ts`) |
| Новый код ошибки                   | `shared/src/errors.ts` → `apps/api/src/errors.ts`                       |
| Экран или UI                       | `screens/*.tsx`, `components/ui.tsx`, `styles.css`                       |
| Каркас, шапка, вкладки             | `components/AppLayout.tsx`, `App.tsx`, `styles.css`                      |
| Клубный тариф, расчёт цены         | `packages/shared/src/pricing.ts` → `components/ui.tsx` → тест в `apps/api/src/pricing.test.ts` |
| Клубный статус пользователя        | `shared/src/telegram.ts` (`isSubscribedChannel`) → `plugins/auth.ts` → `api/useViewer.ts` |
| Корзина                            | `store/cart.ts`, `screens/CartScreen.tsx`                               |
| Вызовы Telegram WebApp             | `telegram/webapp.ts`, `telegram/buttons.ts`                             |
| Сообщения и команды бота           | `routes/bot.ts`                                                         |
| Переменные окружения               | `config.ts`, `apps/api/.env.example`, `deploy/setup-server.sh`           |
| Деплой, Caddy, systemd             | `deploy/*`, `.github/workflows/deploy.yml`, `docs/DEPLOYMENT.md`         |
| Состав артефакта для сервера       | `deploy/pack-artifact.mjs`                                              |
| Демо-данные                        | `apps/api/src/cli/seed.ts`                                              |
| Обслуживающие команды              | `apps/api/src/cli/*.ts` (компилируются в `dist/cli/*.js`)                |

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
| Права строками в `ManagerPermission` | SQLite не умеет массивы; JSON-блоб пришлось бы парсить в коде и нельзя индексировать |
| Права — закрытый zod-enum, не строки | опечатка в `requirePermission` иначе даёт вечный 403, неотличимый от честного отказа; проверка при регистрации роняет старт |
| `ADMIN` игнорирует `requirePermission` | иначе каждое новое право нужно было бы выдавать администратору руками |
| `ADMIN` только из `ADMIN_TELEGRAM_IDS`, в обе стороны | без понижения удаление id из env оставляло запись `ADMIN` в БД, и отзыв доступа требовал ручной правки базы |
| Схемы `*Update` не `.partial()` от `*Input` | `.partial()` сохраняет `.default()`: `PUT {sortOrder}` подставил бы `description:''` и `isActive:true`, затерев описание и включив скрытый товар |
| Guard'ы в `preHandler`, а не внутри обработчика | pre-handler нельзя забыть на середине функции, а незащищённый роут видно при чтении списка роутов |
| Управляющие роуты под общим `/api` | защиту задаёт pre-handler; отдельный префикс `/admin` создавал бы иллюзию, что его отсутствие означает «публичный» |
| `DELETE /api/products/:id` деактивирует | `OrderLine.product` — `onDelete: Restrict`: заказанный товар нельзя удалить физически, и не нужно — заказы должны читаться |
| Ключи только добавляются, никогда не удаляются | выданный ключ — это оплаченная покупка, она обязана остаться в аудите |
| `node:test` вместо Jest              | ноль зависимостей и конфигурации, тесты запускаются как есть      |
| Релизы + симлинк `current`           | сломанная сборка не трогает работающий сайт, откат мгновенный     |
| Хранится 2 релиза, чистка до распаковки | релиз с `node_modules` — ~400 МБ; при 5 релизах диск 9.7 ГБ забивался и `tar` падал на ENOSPC ещё до шага, который освобождал место |
| Сборка в CI, на сервер — артефакт    | VPS слабый: `tsc`+`vite` там грозят OOM. Runner бесплатный        |
| `node_modules` едут в артефакте      | `npm ci` на VPS убивал OOM killer (~13.8k файлов). Взамен артефакт привязан к ОС/арх/ABI Node — `deploy.sh` проверяет это жёстко |
| Обслуживающие скрипты в `src/cli/`   | компилируются `tsc` вместе с API, поэтому на сервере запускаются голым `node`; `tsx` — devDependency и в артефакт не попадает |

---

## 12. Что не сделано

Известные пробелы (актуально на 2026-09-03):

- **Проверка подписки на канал не подключена.** `Viewer.isSubscribedChannel`
  всегда `false`: `getChatMember`, `CLUB_CHANNEL_ID` в env и inline-кнопка со
  ссылкой на канал в боте — следующий шаг. До него клубный тариф виден в
  интерфейсе как предложение, но никого не переводит на другую цену.
- **Стандартная цена `L` пока не применяется к заказу.** `createOrder` считает
  сумму по значению из БД (`P`) для всех. Включать `L` в UI и в `createOrder`
  нужно **одной правкой**: если экран покажет `L`, а инвойс придёт на `P`,
  пользователь увидит одну сумму и заплатит другую.
- **Интерфейса админки нет.** API управления готово (раздел 6), но фронтенд его
  не использует: товары и ключи по-прежнему заливаются через `src/cli/seed.ts`,
  Studio или curl.
- Право `REFUND_ORDERS` объявлено, но ни одним роутом не используется: возврат
  Stars обрабатывается только на входящем событии, инициировать его из API
  нельзя.
- Пагинации в `/api/orders/all` нет — только `limit` до 200 и фильтры.
- Ключи можно добавить, но не отозвать: удаление невыданного ключа из склада
  делается вручную.
- Загрузки изображений нет — `imageUrl` заполняется ссылкой вручную.
- Заказы в статусе `FAILED` никак не мониторятся: видны в БД, в UI покупателя и
  в `/api/orders/all`, но никто о них не уведомляет.
- Миграции Prisma не ведутся, используется `db push`.
- Автобэкапов SQLite нет.
