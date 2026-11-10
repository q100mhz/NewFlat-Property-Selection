import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '127.0.0.1',
  // Публичный адрес приложения (без слеша на конце)
  baseUrl: (env.BASE_URL || 'https://propertyselection.itb2bhost.ru').replace(/\/$/, ''),
  // Адрес, на котором клиенты открывают подборки (ссылки /s/…). Пусто — тот же, что BASE_URL.
  publicUrl: (env.PUBLIC_URL || env.BASE_URL || 'https://propertyselection.itb2bhost.ru').replace(/\/$/, ''),
  dbPath: env.DB_PATH || path.join(ROOT, 'data', 'app.sqlite'),

  // Данные локального приложения из Битрикс24 (Разработчикам → Другое → Локальное приложение)
  b24ClientId: env.B24_CLIENT_ID || '',
  b24ClientSecret: env.B24_CLIENT_SECRET || '',
  // Разрешённые домены порталов (через запятую). Пусто = любой портал, прошедший проверку client_id.
  b24AllowedDomains: list(env.B24_ALLOWED_DOMAINS),
  // Главные администраторы приложения (ID пользователей Битрикс24): видят все подборки и управляют настройками,
  // даже если не являются администраторами портала
  appAdminIds: list(env.APP_ADMIN_IDS || '11341').map(Number).filter(Boolean),

  // Секрет для подписи сессий сотрудников внутри iframe
  sessionSecret: env.SESSION_SECRET || '',

  // Каталог
  siteUrl: (env.SITE_URL || 'https://newflat72.ru').replace(/\/$/, ''),
  crawlIntervalHours: Number(env.CRAWL_INTERVAL_HOURS || 6),
  crawlDelayMs: Number(env.CRAWL_DELAY_MS || 400),
  crawlMaxPages: Number(env.CRAWL_MAX_PAGES || 0), // 0 = без ограничения (для отладки можно поставить 2)
  crawlOnStart: env.CRAWL_ON_START !== '0',
  detailTtlHours: Number(env.DETAIL_TTL_HOURS || 12),
  // Через сколько минут тишины после последней оценки клиента писать сводку в таймлайн
  digestDelayMin: Number(env.DIGEST_DELAY_MIN || 5),
  // Часовой пояс агентства: названия подборок, «сегодня/неделя» в дашборде
  timezone: env.APP_TIMEZONE || 'Asia/Yekaterinburg',

  // Брендинг клиентской страницы
  agencyName: env.AGENCY_NAME || 'Центр Недвижимости',
  agencyPhone: env.AGENCY_PHONE || '',
  agencyLogo: env.AGENCY_LOGO || 'https://newflat72.ru/upload/citrus.arealty/e1b/e1b5db5b6f99e457d316a237fbb6a512.png',

  devMode: env.DEV_MODE === '1',
};

// Разделы каталога newflat72.ru, которые индексируются
export const CATALOG_SECTIONS = [
  { path: '/predlozhenija/kvartiry-i-komnaty/kvartiry/', category: 'flat', label: 'Квартиры (вторичка)', deal: 'sale' },
  { path: '/predlozhenija/novostroyki/', category: 'newbuild', label: 'Новостройки', deal: 'sale' },
  { path: '/predlozhenija/kvartiry-i-komnaty/komnaty/', category: 'room', label: 'Комнаты', deal: 'sale' },
  { path: '/predlozhenija/zagorodnaya-nedvizhimost/doma/', category: 'house', label: 'Дома', deal: 'sale' },
  { path: '/predlozhenija/zagorodnaya-nedvizhimost/dachi-i-kottedzhi/', category: 'cottage', label: 'Дачи и коттеджи', deal: 'sale' },
  { path: '/predlozhenija/zagorodnaya-nedvizhimost/taunkhausy/', category: 'townhouse', label: 'Таунхаусы', deal: 'sale' },
  { path: '/predlozhenija/zagorodnaya-nedvizhimost/uchastki/', category: 'land', label: 'Участки', deal: 'sale' },
  { path: '/predlozhenija/kommercheskaya-nedvizhimost/', category: 'commercial', label: 'Коммерческая', deal: 'sale' },
  { path: '/predlozhenija/garazhi/', category: 'garage', label: 'Гаражи', deal: 'sale' },
  { path: '/predlozhenija/arenda/zhilaya-nedvizhimost/', category: 'rent_living', label: 'Аренда жилья', deal: 'rent' },
  { path: '/predlozhenija/arenda/kommercheskaya-nedvizhimost/', category: 'rent_commercial', label: 'Аренда коммерческой', deal: 'rent' },
];

export const DISLIKE_REASONS = [
  'Цена',
  'Район / расположение',
  'Планировка',
  'Площадь',
  'Этаж',
  'Состояние / ремонт',
  'Дом / ЖК',
  'Инфраструктура',
  'Другое',
];

export function assertProductionConfig() {
  const problems = [];
  if (!config.sessionSecret || config.sessionSecret.length < 32) problems.push('SESSION_SECRET (минимум 32 символа)');
  if (!config.b24ClientId) problems.push('B24_CLIENT_ID');
  if (!config.b24ClientSecret) problems.push('B24_CLIENT_SECRET');
  return problems;
}
