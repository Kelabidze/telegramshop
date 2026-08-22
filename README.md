# Telegram Mini App Shop

Магазин цифровых товаров внутри Telegram: каталог → корзина → оплата
(Telegram Stars) → моментальная выдача ключа/ссылки в чат.

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

Разложено на две части: **один раз** настроить сервер, потом деплоить сколько
угодно. Конфиги лежат в `deploy/`.

Раскладка на сервере — релизы с атомарным переключением симлинка:

```
/srv/shop/
├── repo/                  git-клон (только источник кода)
├── releases/              собранные релизы с таймстемпом
├── current -> releases/…  симлинк на активный релиз
└── shared/
    ├── api.env            секреты (деплой их не трогает)
    └── data/prod.db       база (переживает деплои)
```

### Шаг 1. Залить код на GitHub

Репозиторий уже инициализирован, первый коммит сделан. Создайте пустое репо на
GitHub и запушьте:

```bash
git remote add origin https://github.com/<вы>/<репо>.git
git branch -M main
git push -u origin main
```

### Шаг 2. Направить домен на VPS

A-запись `shop.example.com` → IP сервера. Проверить:

```bash
dig +short shop.example.com
```

Пока DNS не резолвится, Caddy не получит сертификат.

### Шаг 3. Настроить сервер (один раз)

На VPS под root:

```bash
git clone https://github.com/<вы>/<репо>.git /srv/shop/repo
cd /srv/shop/repo
sudo DOMAIN=shop.example.com bash deploy/setup-server.sh
```

Скрипт идемпотентный — можно запускать повторно. Он ставит Node 22, Caddy,
создаёт пользователя `shop`, раскладку каталогов, генерирует секрет вебхука,
настраивает firewall (наружу только 80/443, порт 8080 закрыт) и разрешает
пользователю `shop` перезапускать **только** свой сервис.

### Шаг 4. Вписать токен бота

```bash
sudo nano /srv/shop/shared/api.env      # TELEGRAM_BOT_TOKEN=...
```

В production сервер **не запустится** без токена, с `ALLOW_DEV_AUTH=true` или
без секрета вебхука — это защита от опасной конфигурации, не придирка.

### Шаг 5. Первый деплой

```bash
sudo -u shop REPO_URL=https://github.com/<вы>/<репо>.git \
     bash /srv/shop/repo/deploy/deploy.sh
```

Что делает `deploy.sh`:

1. забирает нужный коммит, собирает в **новый** каталог релиза;
2. применяет схему БД (`db push`) и собирает API + фронтенд;
3. проверяет, что артефакты реально появились;
4. атомарно переключает `current` и перезапускает сервис;
5. ждёт `/health`, и **при неудаче откатывается на предыдущий релиз**;
6. чистит старые релизы, никогда не удаляя активный.

Сломанная сборка не «уронит» работающий сайт: переключение происходит только
после успешной сборки.

### Шаг 6. Вебхук и BotFather

```bash
cd /srv/shop/current/apps/api
sudo -u shop npm run bot:set-webhook
```

Затем в @BotFather: `/newapp` → Web App URL = `https://shop.example.com`.

### Шаг 7. Автодеплой из GitHub

`.github/workflows/deploy.yml` на каждый push в `main` сначала прогоняет
typecheck, тесты и сборку, и **только если всё зелёное** — деплоит по SSH.
Сломанный коммит до сервера не доходит.

Сгенерируйте отдельный ключ для деплоя (на своей машине):

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f deploy_key -N ""
ssh-copy-id -i deploy_key.pub shop@<ip-сервера>
```

В GitHub → Settings → Secrets and variables → Actions добавьте:

| Secret     | Значение                              |
| ---------- | ------------------------------------- |
| `SSH_HOST` | IP или домен сервера                  |
| `SSH_USER` | `shop`                                |
| `SSH_KEY`  | содержимое приватного `deploy_key`    |
| `DOMAIN`   | `shop.example.com`                    |
| `SSH_PORT` | порт SSH, если не 22 (необязательно)  |

Приватный ключ после этого удалите с диска: он живёт только в секретах GitHub.

### Эксплуатация

```bash
sudo systemctl status shop-api          # состояние
sudo journalctl -u shop-api -f          # логи в реальном времени
sudo systemctl restart shop-api         # перезапуск
curl -s localhost:8080/health           # health изнутри сервера
```

Откат на предыдущий релиз вручную:

```bash
ls -1t /srv/shop/releases               # выбрать нужный
sudo -u shop ln -sfnT /srv/shop/releases/<релиз> /srv/shop/current.new
sudo -u shop mv -Tf /srv/shop/current.new /srv/shop/current
sudo systemctl restart shop-api
```

Бэкап базы (SQLite — один файл):

```bash
sudo -u shop cp /srv/shop/shared/data/prod.db /srv/shop/shared/data/backup-$(date +%F).db
```

### Известные ограничения тестового стенда

- **SQLite**, а не Postgres: одна машина, без репликации. Для теста нормально,
  для реальной нагрузки см. раздел про переход на PostgreSQL.
- **Нет автобэкапов** — команда выше добавляется в cron при необходимости.
- Сборка идёт **на сервере**, поэтому деплой на слабом VPS занимает 1–3 минуты
  и на это время потребляет CPU. Альтернатива — собирать в CI и копировать
  артефакты.

## Команды

```bash
npm run dev              # API + Mini App одновременно
npm run dev:api          # только API
npm run dev:web          # только фронтенд
npm test                 # тесты (32 шт.)
npm run typecheck        # проверка типов во всех пакетах
npm run build            # production-сборка
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
