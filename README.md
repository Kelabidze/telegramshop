# Telegram Mini App Shop

Магазин цифровых товаров внутри Telegram: каталог → корзина → оплата
(Telegram Stars) → моментальная выдача ключа/ссылки в чат.

## Документация

| Файл                                       | Для кого и о чём                                     |
| ------------------------------------------ | ---------------------------------------------------- |
| **этот README**                            | человек: установка и первый запуск                    |
| [`AGENTS.md`](AGENTS.md)                   | ИИ-ассистент: правила, инварианты, протокол входа      |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | карта кода, потоки данных, обоснования решений    |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | продакшен: VPS, деплой, эксплуатация, откат           |
| [`CHANGELOG.md`](CHANGELOG.md)             | история изменений                                     |

Работаете с ИИ-ассистентом? Достаточно написать:
«Прочитай AGENTS.md и следуй протоколу входа».

## Стек

| Слой      | Технологии                                              |
| --------- | ------------------------------------------------------- |
| Frontend  | React 19, Vite 8, TypeScript, TanStack Query, Zustand   |
| Backend   | Node.js, Fastify 5, Prisma 7, grammY                    |
| БД        | SQLite (dev) → PostgreSQL (prod, без переписывания кода) |
| Оплата    | Telegram Stars (XTR), провайдер подключается отдельно    |

## Структура

```
packages/shared      общие zod-схемы и типы (один контракт для фронта и бэка)
apps/api             Fastify API + Telegram-бот + Prisma
apps/miniapp         React Mini App
```

## Установка

Требуется Node.js ≥ 20.11.

```bash
npm install
```

> Если npm сообщит о заблокированных install-скриптах, выполните
> `npm approve-scripts better-sqlite3 prebuild-install @prisma/engines prisma esbuild`
> и повторите `npm install`. Это нужно для нативного модуля SQLite.

## Шаг 1. Создать бота

1. Откройте [@BotFather](https://t.me/BotFather) → `/newbot`, задайте имя.
2. Скопируйте **токен** — это ключ подписи `initData`. Обращайтесь с ним
   как с паролем: кто владеет токеном, тот может подделать любого пользователя.

## Шаг 2. Настроить переменные окружения

```bash
cp apps/api/.env.example apps/api/.env
cp apps/miniapp/.env.example apps/miniapp/.env
```

В `apps/api/.env` заполните минимум:

```ini
TELEGRAM_BOT_TOKEN="123456:AA..."          # от BotFather
TELEGRAM_WEBHOOK_SECRET="<случайная строка>"
ADMIN_TELEGRAM_IDS="<ваш telegram id>"     # необязательно
```

Сгенерировать секрет вебхука:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Шаг 3. Создать базу и наполнить демо-товарами

```bash
npm run db:push
npm run db:seed
```

## Шаг 4. Запустить

```bash
npm run dev
```

- API: http://127.0.0.1:8080 (`/health` для проверки)
- Mini App: http://localhost:5173

Vite проксирует `/api` на бэкенд, поэтому фронт и API работают на одном
origin — CORS не нужен, и одного туннеля достаточно для обоих.

### Разработка в обычном браузере

Откройте http://localhost:5173. Вне Telegram `initData` отсутствует, поэтому
API принимает заголовок `x-dev-telegram-id` (значение из
`VITE_DEV_TELEGRAM_ID`). Работает **только** при `ALLOW_DEV_AUTH=true` и
автоматически запрещено в production. Оплата вне Telegram недоступна.

## Шаг 5. Открыть внутри Telegram (нужен HTTPS)

Telegram открывает Mini App только по HTTPS, `localhost` не подойдёт.
Поднимите туннель на **порт Vite**:

```bash
npm run tunnel        # cloudflared tunnel --url http://localhost:5173
```

Установить cloudflared, если его нет:

```bash
winget install --id Cloudflare.cloudflared
```

Затем в BotFather: `/newapp` → выберите бота → в качестве Web App URL укажите
адрес туннеля (`https://<...>.trycloudflare.com`).

## Шаг 6. Подключить оплату

Для приёма платежей Telegram должен доставлять события боту, а значит нужен
вебхук на публичный HTTPS-адрес **API**.

Поднимите второй туннель на порт 8080, запишите его в `PUBLIC_API_URL`
(`apps/api/.env`) и зарегистрируйте вебхук:

```bash
npm run bot:set-webhook
# снять:
npm run bot:delete-webhook
```

Проверить, что всё сошлось: оформите заказ на бесплатный товар
(«Стартовый набор») — он выдаётся без оплаты и не требует вебхука.

### Stars и реальные деньги

- **Stars (по умолчанию)** — `PAYMENT_PROVIDER="stars"`, цены в целых звёздах,
  провайдер не нужен. Подходит для цифровых товаров.
- **Провайдер** (ЮKassa, Stripe и т.п.) — получите токен в BotFather → Payments,
  задайте `PAYMENT_PROVIDER="provider"` и `TELEGRAM_PROVIDER_TOKEN`, а цены
  указывайте в копейках/центах.

Платёжный слой изолирован в `apps/api/src/payments/gateway.ts`, поэтому
добавление провайдера не затрагивает логику заказов.

## Деплой на VPS

Продакшен полностью описан в **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)**:
раскладка каталогов, первичная настройка сервера одной командой, автодеплой из
GitHub Actions, эксплуатация, откат и бэкап.

Коротко: `ochkisk.shop` → `176.119.156.77`, Caddy отдаёт статику и проксирует
`/api`, релизы переключаются симлинком атомарно. **Сборка идёт на GitHub
Actions** — сервер получает готовый архив ~0.2 МБ и ничего не компилирует,
поэтому деплой не грузит слабый VPS.

```bash
# один раз на сервере
curl -fsSL https://raw.githubusercontent.com/Kelabidze/telegramshop/main/deploy/setup-server.sh | sudo bash
sudo nano /srv/shop/shared/api.env        # вписать TELEGRAM_BOT_TOKEN

# дальше деплой сам: push в main -> CI собирает -> артефакт уезжает на сервер
```

Собрать и отправить артефакт вручную:

```bash
npm run build && npm run pack
scp build/artifact.tar.gz* shop@176.119.156.77:/srv/shop/incoming/
ssh shop@176.119.156.77 'bash /srv/shop/repo/deploy/deploy.sh'
```

## Команды

```bash
npm run dev              # API + Mini App одновременно
npm run dev:api          # только API
npm run dev:web          # только фронтенд
npm test                 # тесты (32 шт.)
npm run typecheck        # проверка типов во всех пакетах
npm run build            # production-сборка
npm run pack             # артефакт для сервера (после build)
npm run db:studio        # GUI для базы
npm run db:seed          # демо-данные (идемпотентно)
```

## Как устроена безопасность

Эти инварианты покрыты тестами (`apps/api/src/**/*.test.ts`):

1. **Подпись `initData`.** Проверяется HMAC-SHA256 по алгоритму Telegram.
   В строку проверки входят все поля, кроме `hash` — включая новое поле
   `signature`. Сравнение хешей — constant-time. Клиент никогда не сообщает
   свой `user_id` сам.
2. **Цены только из БД.** Тело запроса содержит лишь `productId` и
   `quantity`. Попытка прислать свою цену или `status: "PAID"` игнорируется.
3. **Никакой выдачи до оплаты.** `deliveredPayload` заполняется только после
   подтверждённого Telegram платежа.
4. **Защита от перепродажи.** Ключи — это строки таблицы, а не счётчик.
   Выдача — условный `UPDATE` с проверкой `claimedAt IS NULL`, поэтому два
   одновременных покупателя не получат один ключ.
5. **Идемпотентность.** Telegram повторяет вебхуки. `update_id` фиксируется в
   `ProcessedUpdate`, а повторная обработка платежа не выдаёт второй ключ.
6. **Изоляция заказов.** Чужой заказ отдаёт 404, а не 403 — существование
   заказов других пользователей не раскрывается.
7. **Проверки конфигурации.** В production сервер не запустится с
   `ALLOW_DEV_AUTH=true`, без токена бота или без секрета вебхука.

## Переход на PostgreSQL

1. `apps/api/prisma/schema.prisma`: `provider = "postgresql"`.
2. `apps/api/src/db.ts` и `prisma.config.ts`: заменить адаптер на
   `@prisma/adapter-pg`.
3. `DATABASE_URL` — строка подключения, затем `npx prisma migrate dev`.

Схема специально не использует SQLite-специфичных типов, поэтому модели
переносятся без изменений.

## Что стоит доделать перед продакшеном

- Загрузка изображений товаров (сейчас `imageUrl` заполняется вручную).
- Админка: добавление товаров и загрузка ключей (сейчас — через `db:seed`).
- Возвраты Stars (`refundStarPayment`) из интерфейса администратора.
- Мониторинг заказов со статусом `FAILED` — оплата прошла, выдача не удалась.

## Как устроен код

Структура каталогов, потоки данных, модель БД, список эндпоинтов и обоснования
принятых решений — в **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**.
