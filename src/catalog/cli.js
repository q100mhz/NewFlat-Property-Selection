// Ручной запуск индексации каталога: npm run crawl
import { crawlCatalog, catalogStats } from './catalog.js';
import { installNetwork } from '../net.js';

installNetwork();
await crawlCatalog();
console.log(catalogStats());
