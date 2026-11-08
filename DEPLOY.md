# Перенос на VPS 89.111.170.193

Пошаговая инструкция для чистого сервера на **Ubuntu 22.04 / 24.04** (для Debian 12 команды те же). Все команды выполняются от `root`, если не сказано иное.

Итог: приложение работает как служба systemd от отдельного пользователя `propsel` в `/opt/propertyselection`. Снаружи его закрывает nginx с HTTPS на `https://propertyselection.itb2bhost.ru`.

---

## 0. DNS (до всего остального)

В DNS-зоне `itb2bhost.ru` создайте A-запись:

```
propertyselection   A   89.111.170.193
```

Проверка (с вашего компьютера; запись может применяться от нескольких минут до пары часов):

```bash
dig +short propertyselection.itb2bhost.ru
```

Должно вернуться `89.111.170.193`. Без этого не получится выпустить SSL-сертификат (шаг 7).

## 1. Вход на сервер и базовая настройка

```bash
ssh root@89.111.170.193
```

```bash
apt update && apt -y upgrade
apt -y install curl git nginx sqlite3 ufw build-essential python3
timedatectl set-timezone Asia/Yekaterinburg
```

`build-essential` и `python3` нужны на случай, если модуль SQLite придётся собирать из исходников. Обычно скачивается готовая сборка.

Брандмауэр (SSH, HTTP, HTTPS):

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

## 2. Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs
node -v   # должно быть v22.x
```

## 3. Пользователь и код приложения

```bash
useradd -r -m -d /opt/propertyselection -s /bin/bash propsel
sudo -u propsel git clone https://github.com/q100mhz/NewFlat-Property-Selection.git /opt/propertyselection/app
```

> Если репозиторий **приватный**, git попросит логин и пароль. Вместо пароля нужен Personal Access Token (GitHub → Settings → Developer settings → Fine-grained tokens, доступ только на чтение к этому репозиторию). Другой вариант — deploy key: `sudo -u propsel ssh-keygen -t ed25519`, публичный ключ добавить в репозиторий (Settings → Deploy keys) и клонировать по `git@github.com:q100mhz/NewFlat-Property-Selection.git`.

Установка зависимостей (только рабочие, без dev):

```bash
cd /opt/propertyselection/app
sudo -u propsel npm ci --omit=dev
```

## 4. Настройка `.env`

```bash
sudo -u propsel cp .env.example .env
openssl rand -hex 32          # скопируйте результат — это SESSION_SECRET
sudo -u propsel nano .env
```

Заполните:

| Параметр | Значение |
|---|---|
| `BASE_URL` | `https://propertyselection.itb2bhost.ru` |
| `SESSION_SECRET` | строка из `openssl rand -hex 32` |
| `B24_ALLOWED_DOMAINS` | домен портала агентства, например `agency.bitrix24.ru` |
| `AGENCY_PHONE` | телефон агентства для страницы клиента |
| `B24_CLIENT_ID`, `B24_CLIENT_SECRET` | пока оставьте пустыми — их выдаст Битрикс24 на шаге 8 |

Права на файл с секретами:

```bash
chmod 600 /opt/propertyselection/app/.env
```

## 5. Служба systemd

Файл службы в репозитории рассчитан на путь `/opt/propertyselection`, а код лежит в `/opt/propertyselection/app`. Поэтому поправим путь при копировании:

```bash
sed 's#WorkingDirectory=/opt/propertyselection#WorkingDirectory=/opt/propertyselection/app#' \
  /opt/propertyselection/app/deploy/propertyselection.service > /etc/systemd/system/propertyselection.service
systemctl daemon-reload
systemctl enable propertyselection
```

Запускать пока не нужно: без ключей Битрикс24 приложение завершится с сообщением о незаполненных параметрах. Запустим на шаге 8.

## 6. nginx (пока по HTTP — для выпуска сертификата)

Конфиг в репозитории уже ссылается на сертификат, которого ещё нет, поэтому сначала временный HTTP-конфиг:

```bash
cat > /etc/nginx/sites-available/propertyselection.itb2bhost.ru <<'EOF'
server {
    listen 80;
    server_name propertyselection.itb2bhost.ru;
    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; }
}
EOF
ln -sf /etc/nginx/sites-available/propertyselection.itb2bhost.ru /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

## 7. SSL-сертификат Let's Encrypt

```bash
apt -y install certbot python3-certbot-nginx
certbot --nginx -d propertyselection.itb2bhost.ru --agree-tos -m <ваш-email> --redirect
```

Теперь поставим полноценный конфиг из репозитория (HTTPS, редирект, заголовки прокси):

```bash
cp /opt/propertyselection/app/deploy/nginx.conf /etc/nginx/sites-available/propertyselection.itb2bhost.ru
nginx -t && systemctl reload nginx
```

Сертификат продлевается автоматически (`systemctl list-timers | grep certbot`).

## 8. Регистрация приложения в Битрикс24 и запуск

1. Портал → **Разработчикам → Другое → Локальное приложение**.
2. **Серверное**, «Использует только API» — **нет**.
3. Путь обработчика: `https://propertyselection.itb2bhost.ru/b24/handler`
4. Путь первоначальной установки: `https://propertyselection.itb2bhost.ru/b24/install`
5. Права: **CRM**, **Встраивание приложений**, **Чат и уведомления**, **Пользователи**.
6. Сохраните. Скопируйте «Код приложения» → `B24_CLIENT_ID`, «Ключ приложения» → `B24_CLIENT_SECRET` в `.env`:

   ```bash
   sudo -u propsel nano /opt/propertyselection/app/.env
   systemctl start propertyselection
   systemctl status propertyselection --no-pager
   curl -s https://propertyselection.itb2bhost.ru/health   # {"ok":true}
   ```

7. Подождите 5–10 минут, пока загрузится каталог. Ход загрузки видно в логе:

   ```bash
   journalctl -u propertyselection -f
   ```

   В конце будет строка `[crawl] готово: … карточек`.
8. В Битрикс24 откройте приложение (раздел «Приложения» или ссылка из списка локальных приложений). Пройдёт установка: появится сообщение «Приложение установлено», и в карточках лидов и сделок появится вкладка **«Подборка»**.

## 9. Проверка после установки

- [ ] Откройте любой лид → вкладка «Подборка» → «Новая подборка». Каталог показывает объекты с фото.
- [ ] Добавьте 2–3 объекта, создайте подборку. В таймлайне лида появился комментарий со ссылкой.
- [ ] Откройте ссылку с телефона (лучше не из того же браузера). Вам пришло уведомление «Клиент открыл подборку».
- [ ] Оцените объекты и нажмите «Отправить ответ». В таймлайне появился итог, пришло уведомление, во вкладке видны оценки.

Если что-то не так, см. раздел «Проблемы» ниже.

## 10. Резервные копии базы

Вся ценная информация (подборки и ответы клиентов) лежит в `data/app.sqlite`. Каталог и кэш фото восстанавливаются сами.

```bash
mkdir -p /var/backups/propertyselection
cat > /etc/cron.daily/propertyselection-backup <<'EOF'
#!/bin/sh
D=/var/backups/propertyselection
sqlite3 /opt/propertyselection/app/data/app.sqlite ".backup '$D/app-$(date +%F).sqlite'"
find "$D" -name 'app-*.sqlite' -mtime +30 -delete
EOF
chmod +x /etc/cron.daily/propertyselection-backup
/etc/cron.daily/propertyselection-backup && ls -la /var/backups/propertyselection
```

Желательно периодически забирать копии с сервера к себе (например, `scp root@89.111.170.193:/var/backups/propertyselection/*.sqlite .`) или настроить бэкап у хостера.

## 11. Обновление приложения

Когда в репозитории появятся изменения:

```bash
cd /opt/propertyselection/app
sudo -u propsel git pull
sudo -u propsel npm ci --omit=dev
systemctl restart propertyselection
journalctl -u propertyselection -n 30 --no-pager
```

Если менялся набор встроек (новые вкладки), переустановите приложение в Битрикс24.

## Полезные команды

| Что | Команда |
|---|---|
| Статус | `systemctl status propertyselection` |
| Логи в реальном времени | `journalctl -u propertyselection -f` |
| Перезапуск | `systemctl restart propertyselection` |
| Принудительно обновить каталог | `cd /opt/propertyselection/app && sudo -u propsel npm run crawl` |
| Размер данных | `du -sh /opt/propertyselection/app/data/*` |

## Проблемы

**Служба сразу останавливается, в логе «Не заданы обязательные параметры».** Не заполнен `.env`: `SESSION_SECRET` (не короче 32 символов), `B24_CLIENT_ID` или `B24_CLIENT_SECRET`.

**При установке в Битрикс24 ошибка «Токен выдан другому приложению».** Проверьте, что `B24_CLIENT_ID` в `.env` совпадает с «Кодом приложения» в Битрикс24, и перезапустите службу. Если совпадает, а ошибка остаётся, пришлите строки из `journalctl -u propertyselection` — значит, портал возвращает код приложения в другом поле, это правится в `src/server.js` (функция `verifyAppToken`).

**Вкладка «Подборка» не появилась.** Переустановите приложение. При установке в логе пишется строка `[install] …` с результатом регистрации вкладок.

**Нет комментариев в таймлайне или уведомлений.** Проверьте права приложения (CRM, Чат и уведомления) и строки `[timeline]` / `[notify]` в логе.

**Ошибка «Недопустимый домен портала».** Домен портала не совпадает с `B24_ALLOWED_DOMAINS`. Укажите его в точности как в адресной строке, без `https://`.

**Каталог пустой или неполный.** Сайт newflat72.ru временами обрывает соединения. Приложение повторяет запросы, а при неполном обходе запускает его снова через 30 минут. Смотрите строки `[crawl]` в логе.
