# Установка на сервер 89.111.170.193

Инструкция составлена под текущую конфигурацию сервера: Ubuntu 24.04, nginx + certbot, приложения в Docker на `127.0.0.1`, ufw уже настроен.

**Как приложение встанет на сервер:**

| Что | Где |
|---|---|
| Код | `/opt/propertyselection` (рядом с `/opt/publisher` и `/opt/welegalcompliance`) |
| Контейнер | `propertyselection-app-1` в сети сервера, слушает только `127.0.0.1:3200`, не больше 384 МБ памяти |
| Данные (база, кэш фото) | Docker-том `propertyselection_data` |
| Сайт nginx | `/etc/nginx/sites-available/propertyselection.itb2bhost.ru.conf` |
| Сертификат | отдельный, только для `propertyselection.itb2bhost.ru` |

**Что не трогаем:** существующие сайты nginx, контейнеры, брандмауэр, системные пакеты, часовой пояс. Каждая команда либо создаёт новые файлы, либо касается только этого приложения. Перед каждой перезагрузкой nginx идёт проверка `nginx -t`: если она покажет ошибку, nginx не перезагружается и ваши сайты продолжают работать.

Все команды выполняются на сервере от `root`:

```bash
ssh root@89.111.170.193
```

---

## Шаг 1. Проверка перед началом

```bash
ss -tln | grep -E ':3200\b' || echo "порт 3200 свободен"
getent hosts propertyselection.itb2bhost.ru
ls /opt/propertyselection 2>/dev/null || echo "папка свободна"
```

Ожидается: `порт 3200 свободен`, адрес `89.111.170.193` и `папка свободна`.

## Шаг 2. Загрузка кода

```bash
git clone https://github.com/q100mhz/NewFlat-Property-Selection.git /opt/propertyselection
cd /opt/propertyselection
git log --oneline -1
```

Если репозиторий приватный, git спросит логин и пароль. Вместо пароля введите токен GitHub: Settings → Developer settings → Personal access tokens → Fine-grained, доступ **Contents: Read-only** только к этому репозиторию.

## Шаг 3. Настройки и пробная сборка

Создайте файл настроек и сгенерируйте секрет:

```bash
cd /opt/propertyselection
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Откройте файл (`nano .env`; сохранить — Ctrl+O, Enter; выйти — Ctrl+X) и заполните:

```
BASE_URL=https://propertyselection.itb2bhost.ru
SESSION_SECRET=<строка из openssl rand -hex 32>
B24_ALLOWED_DOMAINS=<домен вашего портала, например agency.bitrix24.ru>
AGENCY_PHONE=<телефон агентства, например +7 (3452) 00-00-00>
```

```bash
nano .env
```

`B24_CLIENT_ID` и `B24_CLIENT_SECRET` пока оставьте как есть — их выдаст Битрикс24 на шаге 5. Строки `PORT` и `HOST` не важны: их задаёт `docker-compose.yml`.

Соберите образ. Он только собирается и пока не запускается; займёт 2–4 минуты:

```bash
docker compose build
docker images propertyselection-app
```

В конце должна появиться строка с образом `propertyselection-app`.

## Шаг 4. Сайт в nginx и SSL-сертификат

```bash
cp /opt/propertyselection/deploy/nginx.conf /etc/nginx/sites-available/propertyselection.itb2bhost.ru.conf
ln -s /etc/nginx/sites-available/propertyselection.itb2bhost.ru.conf /etc/nginx/sites-enabled/
nginx -t
```

**Только если `nginx -t` написал `syntax is ok` и `test is successful`**, перезагрузите nginx:

```bash
systemctl reload nginx
```

> Если `nginx -t` показал ошибку, не перезагружайте nginx. Уберите новый сайт командой `rm /etc/nginx/sites-enabled/propertyselection.itb2bhost.ru.conf` и пришлите мне текст ошибки.

Выпустите сертификат. certbot сам добавит HTTPS и редирект в конфиг нового сайта, как он уже делал для остальных:

```bash
certbot --nginx -d propertyselection.itb2bhost.ru --redirect
```

Проверка:

```bash
nginx -t && systemctl reload nginx
curl -sI https://propertyselection.itb2bhost.ru | head -1
```

Пока приложение не запущено, ответ будет `HTTP/2 502` — это нормально. Важно, что HTTPS отвечает и нет ошибок сертификата.

## Шаг 5. Регистрация приложения в Битрикс24

На портале (нужны права администратора):

1. **Разработчикам** (или **Приложения → Разработчикам**) → **Другое** → **Локальное приложение**.
2. Тип: **Серверное**. Галочку «Использует только API» **не ставить**.
3. Название: `Подборка`.
4. Путь вашего обработчика: `https://propertyselection.itb2bhost.ru/b24/handler`
5. Путь для первоначальной установки: `https://propertyselection.itb2bhost.ru/b24/install`
6. Права: **CRM (crm)**, **Встраивание приложений (placement)**, **Чат и уведомления (im)**, **Пользователи (user)**, **Структура компании (department)**.
7. **Сохранить.** Откроется страница с «Кодом приложения» (`local.…`) и «Ключом приложения».

Пока **не открывайте** приложение на портале: сначала его нужно запустить на сервере.

Впишите ключи в настройки:

```bash
cd /opt/propertyselection
nano .env
```

```
B24_CLIENT_ID=<Код приложения, local.xxxxxxxx.xxxxxxxx>
B24_CLIENT_SECRET=<Ключ приложения>
```

## Шаг 6. Запуск

```bash
cd /opt/propertyselection
docker compose up -d
docker compose ps
docker compose logs --tail 30
```

В `ps` у контейнера должен быть статус `Up` (через полминуты — `Up (healthy)`). В логах должна быть строка `Подборка: http://127.0.0.1:3200`.

> Если контейнер перезапускается и в логе написано «Не заданы обязательные параметры в .env», проверьте `SESSION_SECRET` (не короче 32 символов), `B24_CLIENT_ID` и `B24_CLIENT_SECRET`, затем выполните `docker compose up -d` ещё раз.

Проверка снаружи:

```bash
curl -s https://propertyselection.itb2bhost.ru/health
```

Ожидается `{"ok":true}`.

Сразу после запуска начинается первая загрузка каталога newflat72.ru. Она занимает 5–10 минут; ход виден в логе (выход — Ctrl+C):

```bash
docker compose logs -f
```

В конце будет строка `[crawl] готово: … карточек`.

## Шаг 7. Установка в Битрикс24

1. На портале откройте **Приложения** → найдите «Подборка» (или откройте его из списка локальных приложений) → **открыть**.
2. Должно появиться сообщение **«Приложение «Подборка» установлено»**.
3. Проверьте лог установки на сервере:

   ```bash
   docker compose -f /opt/propertyselection/docker-compose.yml logs | grep install
   ```

   Нужна строка вида `[install] ваш-портал.bitrix24.ru [{"placement":"CRM_LEAD_DETAIL_TAB","ok":true},{"placement":"CRM_DEAL_DETAIL_TAB","ok":true}]`.

## Шаг 8. Проверка работы

- [ ] Откройте любой лид. Вверху карточки есть вкладка **«Подборка»**.
- [ ] «Новая подборка»: в каталоге видны объекты с фото, работают фильтры.
- [ ] Добавьте 2–3 объекта, нажмите «Создать и получить ссылку». В таймлайне лида появился комментарий со ссылкой.
- [ ] Откройте ссылку на телефоне. Пришло уведомление «Клиент открыл подборку».
- [ ] Оцените объекты и нажмите «Отправить ответ». В таймлайне появился итог, пришло уведомление, во вкладке видны оценки.
- [ ] Проверьте то же самое в сделке.

Если что-то не работает, пришлите мне вывод:

```bash
docker compose -f /opt/propertyselection/docker-compose.yml logs --tail 100
```

## Шаг 9. Ежедневные резервные копии

Копия базы с подборками и ответами клиентов будет делаться каждую ночь в 03:30. Хранятся 14 последних.

```bash
cat > /etc/cron.d/propertyselection-backup <<'EOF'
30 3 * * * root cd /opt/propertyselection && docker compose exec -T app node src/backup.js >> /var/log/propertyselection-backup.log 2>&1
EOF
cd /opt/propertyselection && docker compose exec -T app node src/backup.js
```

Последняя команда сразу делает первую копию для проверки. Сами копии лежат на сервере здесь:

```bash
ls -la /var/lib/docker/volumes/propertyselection_data/_data/backups/
```

Скачать копию на свой компьютер (выполнять на Mac, не на сервере):

```bash
scp 'root@89.111.170.193:/var/lib/docker/volumes/propertyselection_data/_data/backups/*.sqlite' ~/Downloads/
```

---

## Адрес для клиентов (newflat72.itb2bhost.ru)

Ссылки, которые получают клиенты, ведут на отдельный адрес `PUBLIC_URL`. На нём открываются только страницы подборок, служебная часть приложения остаётся на `BASE_URL`. Старые ссылки на `BASE_URL/s/…` продолжают работать.

```bash
cp /opt/propertyselection/deploy/nginx-client.conf /etc/nginx/sites-available/newflat72.itb2bhost.ru.conf
ln -s /etc/nginx/sites-available/newflat72.itb2bhost.ru.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d newflat72.itb2bhost.ru --redirect
grep -q '^PUBLIC_URL=' /opt/propertyselection/.env || echo 'PUBLIC_URL=https://newflat72.itb2bhost.ru' >> /opt/propertyselection/.env
cd /opt/propertyselection && docker compose up -d
```

## Обновление приложения

```bash
cd /opt/propertyselection
git pull
docker compose up -d --build
docker compose ps
docker compose logs --tail 30
```

Данные в томе при обновлении сохраняются.

## Полезные команды

Выполнять в папке `/opt/propertyselection`:

| Что | Команда |
|---|---|
| Состояние | `docker compose ps` |
| Логи в реальном времени | `docker compose logs -f` |
| Перезапуск | `docker compose restart` |
| Остановка | `docker compose stop` |
| Память и процессор | `docker stats --no-stream propertyselection-app-1` |
| Размер данных | `du -sh /var/lib/docker/volumes/propertyselection_data/_data/*` |
| Обновить каталог вручную | кнопка «Обновить каталог сейчас» на странице приложения в Битрикс24 (нужны права администратора) |

## Полное удаление

Если понадобится убрать приложение с сервера (остальные сайты и контейнеры не затрагиваются):

```bash
cd /opt/propertyselection && docker compose down        # контейнер; данные пока остаются
rm /etc/nginx/sites-enabled/propertyselection.itb2bhost.ru.conf
nginx -t && systemctl reload nginx
certbot delete --cert-name propertyselection.itb2bhost.ru
rm /etc/cron.d/propertyselection-backup
# необратимо — база с подборками:
# docker volume rm propertyselection_data && rm -rf /opt/propertyselection
```

## Проблемы

**При установке в Битрикс24 ошибка «Токен выдан другому приложению».** Сверьте `B24_CLIENT_ID` в `.env` с «Кодом приложения» в Битрикс24 и выполните `docker compose up -d`. Если они совпадают, а ошибка остаётся, пришлите вывод `docker compose logs --tail 50`: значит, портал возвращает код приложения в другом поле, это правится в коде.

**Ошибка «Недопустимый домен портала».** Значение `B24_ALLOWED_DOMAINS` не совпадает с доменом портала. Укажите его точно как в адресной строке, без `https://` и `/`, затем выполните `docker compose up -d`.

**Вкладка «Подборка» не появилась.** Переустановите приложение на портале. В логе (`grep install`) будет видно, какие вкладки зарегистрировались.

**Нет комментариев в таймлайне или уведомлений.** Проверьте права приложения (CRM, Чат и уведомления) и строки `[timeline]` / `[notify]` в логе.

**В логе `fetch failed` / `UND_ERR_CONNECT_TIMEOUT` при обращении к порталу.** DNS Битрикс24 отдаёт много адресов, и часть из них может быть недоступна с сервера. Приложение перебирает адреса (по 1,5 с на каждый) и запоминает рабочий (`src/net.js`). Если ошибка всё же повторяется, проверьте доступность адресов с сервера:

```bash
for ip in $(getent ahostsv4 newflat.bitrix24.ru | awk '{print $1}' | sort -u); do printf "%-16s " $ip; curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 --resolve newflat.bitrix24.ru:443:$ip https://newflat.bitrix24.ru/rest/server.time.json || echo "нет связи"; done
```

**Почему контейнер работает в сети сервера (`network_mode: host`).** На этом сервере брандмауэр запрещает маршрутизируемый трафик (`ufw: deny (routed)`), и у отдельной Docker-сети приложения не было выхода в интернет: ни к newflat72.ru, ни к Битрикс24. Брандмауэр — общая настройка сервера, поэтому приложение использует сеть сервера и слушает только `127.0.0.1:3200`.

**Каталог пустой или неполный.** Сайт newflat72.ru иногда обрывает соединения. Приложение повторяет запросы, а при неполном обходе запускает его снова через 30 минут. Смотрите строки `[crawl]` в логе.

**После изменения `.env` ничего не поменялось.** `docker compose restart` не перечитывает `.env`. Нужно выполнить `docker compose up -d`.
