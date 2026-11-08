import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseListing, parseDetail, normalizeProps } from '../src/catalog/parser.js';

const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('listing: карточки и пагинация', () => {
  const { items, lastPage } = parseListing(fx('listing.html'), 'https://newflat72.ru/predlozhenija/kvartiry-i-komnaty/kvartiry/');
  assert.equal(items.length, 20);
  assert.ok(lastPage > 1);
  const o = items[0];
  assert.ok(o.id > 0);
  assert.match(o.url, /^https:\/\/newflat72\.ru\/predlozhenija\//);
  assert.ok(o.price > 100000);
  assert.ok(o.lat > 50 && o.lng > 60);
  assert.ok(o.area_total > 0);
  assert.ok(o.thumb.startsWith('https://newflat72.ru/upload/'));
});

test('detail: вторичка — фото, характеристики, описание', () => {
  const d = parseDetail(fx('detail-flat.html'), 'https://newflat72.ru/x/');
  assert.equal(d.id, 1165057);
  assert.equal(d.price, 4700000);
  assert.equal(d.rooms, 2);
  assert.equal(d.floor, 5);
  assert.equal(d.floors, 5);
  assert.equal(d.area_total, 45.1);
  assert.equal(d.props['Район'], 'Мыс');
  assert.ok(d.photos.length >= 5);
  assert.ok(d.description.length > 100);
});

test('detail: новостройка без жилой площади', () => {
  const d = parseDetail(fx('detail-newbuild.html'), 'https://newflat72.ru/x/');
  assert.equal(d.price, 10700000);
  assert.equal(d.area_living ?? null, null);
  assert.equal(d.props['Тип дома'], 'монолит');
});

test('normalizeProps: студия и этаж N/M', () => {
  const p = normalizeProps({ 'Количество комнат': 'Студия', 'Этаж': '15/17', 'Площадь (общ/жил/кух), м2': '32.3/20/5' });
  assert.deepEqual([p.rooms, p.floor, p.floors, p.area_total, p.area_living, p.area_kitchen], [0, 15, 17, 32.3, 20, 5]);
});
