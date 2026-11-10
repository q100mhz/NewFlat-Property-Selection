/**
 * Загрузка страниц и фото по ссылкам, которые вводят сотрудники.
 *
 * Защита от SSRF (попытки заставить сервер обратиться к внутренним адресам):
 *  - только http(s) и стандартные порты 80/443;
 *  - адреса проверяются в момент подключения (защита и от подмены DNS): запрещены
 *    локальные, частные, служебные и зарезервированные диапазоны IPv4/IPv6;
 *  - переадресации проходят ту же проверку, не больше 5;
 *  - ограничены время ответа и размер (страница — 5 МБ, фото — 15 МБ).
 */
import dns from 'node:dns';
import net from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4num = (ip) => ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;

export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4num(ip);
    return BLOCKED_V4.some(([base, bits]) => ((n ^ v4num(base)) >>> (32 - bits)) === 0);
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8');
  }
  return true;
}

export class FetchBlocked extends Error {
  constructor(msg) { super(msg); this.code = 'BLOCKED'; }
}

function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => isBlockedIp(a.address));
    if (bad || !addrs.length) return cb(new FetchBlocked(`Адрес ${hostname} недоступен для загрузки`));
    if (opts && opts.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}

const agent = new Agent({
  connect: buildConnector({ lookup: safeLookup, timeout: 15000, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 1500 }),
  bodyTimeout: 20000,
  headersTimeout: 15000,
});

export function checkUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new FetchBlocked('Некорректная ссылка'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FetchBlocked('Поддерживаются только ссылки http(s)');
  if (u.username || u.password) throw new FetchBlocked('Ссылки с логином не поддерживаются');
  if (u.port && !['80', '443'].includes(u.port)) throw new FetchBlocked('Нестандартный порт не поддерживается');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedIp(host)) throw new FetchBlocked('Адрес недоступен для загрузки');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new FetchBlocked('Адрес недоступен для загрузки');
  u.hash = '';
  return u;
}

/** Загрузка с проверками. kind: 'page' | 'image'. */
export async function safeFetch(url, { kind = 'page', referer } = {}) {
  const maxBytes = kind === 'image' ? 15 * 1024 * 1024 : 5 * 1024 * 1024;
  let current = checkUrl(url);
  for (let hop = 0; hop <= 5; hop++) {
    const res = await undiciFetch(current, {
      dispatcher: agent,
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'ru-RU,ru;q=0.9',
        Accept: kind === 'image' ? 'image/avif,image/webp,image/*,*/*;q=0.8' : 'text/html,application/xhtml+xml,*/*;q=0.8',
        ...(referer ? { Referer: referer } : {}),
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      current = checkUrl(new URL(res.headers.get('location'), current).toString());
      continue;
    }
    const type = res.headers.get('content-type') || '';
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) { await res.body?.cancel(); throw new FetchBlocked('Слишком большой файл'); }
    // читаем с ограничением размера
    const chunks = [];
    let total = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) throw new FetchBlocked('Слишком большой файл');
        chunks.push(chunk);
      }
    }
    return { status: res.status, url: current.toString(), type, body: Buffer.concat(chunks) };
  }
  throw new FetchBlocked('Слишком много переадресаций');
}
