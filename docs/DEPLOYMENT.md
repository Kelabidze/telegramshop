# Деплой и эксплуатация

Продакшен-стенд: `ochkisk.shop` → `176.119.156.77`, один VPS под Ubuntu.
Caddy отдаёт статику Mini App и проксирует `/api`, `/health`, `/telegram/*`
на Node-процесс под systemd. База — файл SQLite на диске.

**Сборка идёт на GitHub Actions, не на VPS.** Сервер получает готовый архив
~0.2 МБ, ставит только production-зависимости и переключает симлинк. Никакого
`tsc` и `vite` на слабой машине.

---

## 1. Раскладка на сервере

```
/srv/shop/
├── repo/                  git-клон: ТОЛЬКО deploy-скрипты и конфиги сервера
├── incoming/              сюда CI загружает artifact.tar.gz
├── releases/              распакованные релизы с таймстемпом
├── current -> releases/…  симлинк на активный релиз
└── shared/
    ├── api.env            секреты; деплой их не трогает
    └── data/prod.db       база; переживает деплои
```

Логика: артефакт распаковывается в **новый** каталог, там ставятся зависимости,
и только после успешного health-check симлинк `current` остаётся переключённым.
Сломанный релиз не может уронить работающий сайт.

---

## 2. Почему сборка в CI

Раньше VPS делал `npm ci` со всеми devDependencies (~425 МБ: TypeScript, Vite,
Prisma CLI, тестовый тулинг), затем `tsc` и `vite build`. На слабой машине это
2–4 минуты полной загрузки CPU и реальный риск, что OOM killer прибьёт
работающий процесс прямо во время деплоя.

Теперь тяжёлую часть делает бесплатный 4-ядерный runner GitHub, а на сервер
уезжает только то, что он не может произвести сам:

| Этап | Раньше на VPS | Сейчас на VPS |
| --- | --- | --- |
| `npm ci` | ~425 МБ, с devDeps | ~100 МБ, `--omit=dev` |
| `tsc` + `vite build` | 2–4 мин CPU | нет |
| Передача | `git fetch` | архив 0.2 МБ |
| Итого | минуты, риск OOM | десятки секунд |

**Что в артефакте** (`npm run pack` → `deploy/pack-artifact.mjs`):
скомпилированные `apps/api/dist`, `apps/miniapp/dist`, `packages/shared/dist`,
манифесты всех workspace-пакетов, `package-lock.json`, схема и конфиг Prisma,
`artifact.json` с коммитом и версией Node. Без `.map`, `.d.ts` и исходников.

**Чего в артефакте нет — и почему.** `node_modules` не передаются намеренно.
Драйвер SQLite (`better-sqlite3`, зависимость Prisma-адаптера) — нативный
модуль, скомпилированный под конкретную ОС, архитектуру и ABI Node. Скопировать
его с runner'а можно, но любое расхождение версии Node превратится в загадочную
ошибку загрузки модуля. Поэтому зависимости ставятся на сервере: `npm ci`
скачивает готовый бинарник ровно для этой машины (для Linux x64/arm64 и Node
22/24 такие сборки опубликованы, компиляции не будет).

Из этого следует важное требование: **мажорная версия Node в CI и на сервере
должна совпадать.** В workflow она задана в `env.NODE_VERSION`, на сервере её
ставит `setup-server.sh` (`NODE_MAJOR`). При расхождении `deploy.sh` выведет
предупреждение.

---

## 3. Первичная настройка сервера (один раз)

На VPS под root:

```bash
curl -fsSL https://raw.githubusercontent.com/Kelabidze/telegramshop/main/deploy/setup-server.sh | sudo bash
```

Скрипт идемпотентный, повторный запуск безопасен. Что делает:

- ставит Node 22, Caddy, build-essential (страховка, если для какой-то
  платформы не окажется готового бинарника SQLite);
- создаёт пользователя `shop` с `/bin/bash` и заблокированным паролем
  (вход только по SSH-ключу — иначе деплой из GitHub Actions не сработает);
- создаёт раскладку каталогов, включая `incoming/` для артефактов;
- клонирует репозиторий **от имени `shop`** — на сервере из него нужны только
  `deploy/*` и конфиги, код приезжает артефактом;
- генерирует `TELEGRAM_WEBHOOK_SECRET` и создаёт `shared/api.env`;
- ставит Caddyfile и systemd-юнит, подставляя домен;
- выдаёт `shop` право на `systemctl restart|status|is-active shop-api`
  и ничего больше;
- включает ufw: наружу только 22/80/443, порт 8080 закрыт;
- проверяет, что DNS домена указывает на этот сервер.

Переопределение по умолчанию: `DOMAIN=... REPO_URL=... sudo bash deploy/setup-server.sh`.

Затем впишите токен бота:

```bash
sudo nano /srv/shop/shared/api.env      # TELEGRAM_BOT_TOKEN=...
```

Остальное уже заполнено, включая `PUBLIC_API_URL=https://ochkisk.shop`.
В production сервер **не стартует** без токена, без секрета вебхука или с
`ALLOW_DEV_AUTH=true` — это защита, а не придирка.

---

## 4. Деплой

**Автоматически:** push в `main` → `.github/workflows/deploy.yml`.

Job `build` на runner'е: `npm ci` → проверка драйвера SQLite → `prisma generate`
→ typecheck → тесты → `npm run build` → `npm run pack`. Артефакт публикуется в
Actions (хранится 14 дней) — полезно, чтобы посмотреть, что именно уехало.

Job `deploy`: скачивает артефакт, копирует по scp в `/srv/shop/incoming/`,
подтягивает deploy-скрипты на нужный коммит и запускает `deploy.sh`. В конце
проверяет публичный `/health`.

Порядок важен: сначала загрузка файла, только потом установка. Оборвавшаяся
передача не должна перезапускать сервис.

**Вручную на сервере** (артефакт уже в `incoming/`):

```bash
sudo -u shop bash /srv/shop/repo/deploy/deploy.sh /srv/shop/incoming/artifact.tar.gz
# передеплоить тот же коммит:
sudo -u shop FORCE=1 bash /srv/shop/repo/deploy/deploy.sh
```

**Собрать артефакт локально** (например, если GitHub недоступен):

```bash
npm run build
npm run pack                                    # build/artifact.tar.gz
scp build/artifact.tar.gz* shop@176.119.156.77:/srv/shop/incoming/
ssh shop@176.119.156.77 'bash /srv/shop/repo/deploy/deploy.sh'
```

Что делает `deploy.sh`:

1. проверяет sha256 архива и что это валидный tar.gz;
2. читает `artifact.json`, сверяет мажор Node, пропускает работу, если этот
   коммит уже live;
3. распаковывает в новый каталог релиза;
4. `npm ci --omit=dev` и проверка, что нативный драйвер SQLite загружается;
5. `prisma db push` — только добавляет недостающие таблицы и колонки;
6. атомарно переключает `current` и перезапускает сервис;
7. ждёт `/health` до 20 секунд и **при неудаче откатывается** на предыдущий
   релиз (неудачный остаётся на диске — по нему разбирают причину);
8. чистит старые релизы, оставляя 5 и никогда не удаляя активный.

Незавершённый релиз удаляется по `trap`, чтобы битый каталог потом не приняли
за цель отката.

### Секреты GitHub Actions

| Secret       | Значение                           |
| ------------ | ---------------------------------- |
| `SSH_HOST`   | `176.119.156.77`                   |
| `SSH_USER`   | `shop`                             |
| `SSH_KEY`    | приватный ключ деплоя              |
| `SSH_PORT`   | необязательно, по умолчанию 22     |
| `DOMAIN`     | `ochkisk.shop`                     |

Ключ генерируется отдельно (`ssh-keygen -t ed25519 -f deploy_key -N ""`),
публичная часть добавляется в `/home/shop/.ssh/authorized_keys` через root,
приватная — только в секреты GitHub, с диска удаляется.

---

## 4. Вебхук и BotFather

```bash
cd /srv/shop/current/apps/api
sudo -u shop npm run bot:set-webhook
```

Регистрирует `https://<домен>/telegram/webhook` с secret token и подпиской
на `message`, `pre_checkout_query`, `callback_query` (последний пока не
обрабатывается, подписка на него — задел на будущее). Затем в @BotFather:
`/newapp` → Web App URL = `https://ochkisk.shop`.

Наполнить каталог демо-товарами:

```bash
cd /srv/shop/current/apps/api && sudo -u shop npm run db:seed
```

---

## 5. Эксплуатация

```bash
sudo systemctl status shop-api          # состояние
sudo journalctl -u shop-api -f          # логи в реальном времени
sudo systemctl restart shop-api         # перезапуск
curl -s localhost:8080/health           # health изнутри сервера
sudo journalctl -u caddy -n 30          # проблемы с сертификатом
```

Откат вручную:

```bash
ls -1t /srv/shop/releases                                    # выбрать нужный
sudo -u shop ln -sfnT /srv/shop/releases/<релиз> /srv/shop/current.new
sudo -u shop mv -Tf /srv/shop/current.new /srv/shop/current
sudo systemctl restart shop-api
```

Бэкап базы (SQLite — один файл):

```bash
sudo -u shop cp /srv/shop/shared/data/prod.db \
                /srv/shop/shared/data/backup-$(date +%F).db
```

---

## 6. Локальная разработка с Telegram

Telegram открывает Mini App только по HTTPS, `localhost` не подойдёт.

```bash
npm run dev              # API :8080, Mini App :5173
npm run tunnel           # cloudflared на порт Vite
```

Vite проксирует `/api` на бэкенд, поэтому одного туннеля хватает и на
приложение, и на API. Адрес туннеля указывается в BotFather (`/newapp`).

Для приёма платежей нужен вебхук на публичный HTTPS API: поднимите второй
туннель на порт 8080, пропишите его в `PUBLIC_API_URL` и выполните
`npm run bot:set-webhook`.

Проверить стенд без оплаты: закажите бесплатный товар «Стартовый набор» —
он выдаётся сразу и вебхука не требует.

---

## 7. Безопасность стенда

- Порт 8080 закрыт извне, API доступен только через Caddy.
- Заголовки: HSTS, CSP с `frame-ancestors` для доменов Telegram (не `DENY` —
  Mini App живёт в iframe), `nosniff`, скрытый `Server`.
- `index.html` не кешируется, `/assets/*` — иммутабельно на год.
- systemd-юнит ужат: `ProtectSystem=strict`, `NoNewPrivileges`,
  единственный writable путь — `/srv/shop/shared`.
- `api.env` с правами 600, принадлежит `shop`; systemd читает его сам.

---

## 8. Ограничения текущего стенда

- **SQLite**, одна машина, без репликации. Для теста нормально, под нагрузку —
  переход на Postgres (см. ниже).
- **Автобэкапов нет**: команда из раздела 5 при необходимости кладётся в cron.
- `npm ci --omit=dev` на сервере всё ещё занимает десятки секунд и ~100 МБ.
  Убрать и это можно только передачей `node_modules` целиком, что привязывает
  артефакт к платформе и версии Node — сознательный отказ, см. раздел 2.
- Мажор Node в CI и на сервере обязан совпадать. Меняете один — меняйте оба:
  `env.NODE_VERSION` в workflow и `NODE_MAJOR` в `setup-server.sh`.

### Диагностика деплоя

| Симптом | Причина и что делать |
| --- | --- |
| `artifact not found` | CI не догрузил файл; проверьте job `deploy` и права на `/srv/shop/incoming` |
| `artifact checksum mismatch` | обрыв передачи; перезапустите workflow |
| `artifact.json is missing` | загружен не тот архив |
| предупреждение про Node | мажоры CI и сервера разошлись, см. выше |
| `the SQLite driver did not load` | не скачался нативный модуль: смотрите вывод `npm ci` выше; на нестандартной платформе поможет `build-essential` |
| `deploy rolled back` | сайт уже вернулся на прошлый релиз; причина в `journalctl -u shop-api -n 50` |

### Переход на PostgreSQL

1. `apps/api/prisma/schema.prisma`: `provider = "postgresql"`.
2. `apps/api/src/db.ts` и `prisma.config.ts`: адаптер `@prisma/adapter-pg`.
3. `DATABASE_URL` — строка подключения, затем `npx prisma migrate dev`.

Схема не использует SQLite-специфичных типов, поэтому модели переносятся
без изменений. Бонус: исчезает нативный модуль SQLite, и артефакт можно будет
возить вместе с `node_modules`.
