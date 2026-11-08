// Ручной запуск индексации каталога: npm run crawl
import { crawlCatalog, catalogStats } from './catalog.js';

await crawlCatalog();
console.log(catalogStats());
