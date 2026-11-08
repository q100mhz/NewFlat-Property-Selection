/**
 * Сетевые подключения для fetch.
 *
 * У сервисов вроде *.bitrix24.ru DNS отдаёт сразу много адресов в случайном порядке,
 * и часть из них может быть недоступна с конкретного сервера. Стандартный fetch пробует
 * только первый адрес и зависает на нём до таймаута. Здесь подключение перебирает
 * все адреса (по 1,5 с на попытку), а адрес, который ответил, запоминается
 * и при следующих запросах пробуется первым.
 */
import dns from 'node:dns';
import { Agent, buildConnector, setGlobalDispatcher, fetch as undiciFetch } from 'undici';

const ATTEMPT_TIMEOUT_MS = 1500;
const CONNECT_TIMEOUT_MS = 30000;

/** Последний удачный адрес для каждого хоста. */
export const preferredAddress = new Map();

const defaultResolve = (hostname, cb) => dns.lookup(hostname, { all: true }, cb);

export function createConnect(resolveAll = defaultResolve) {
  const lookup = (hostname, opts, cb) => {
    resolveAll(hostname, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs?.length) return cb(Object.assign(new Error(`Нет адресов для ${hostname}`), { code: 'ENOTFOUND' }));
      const good = preferredAddress.get(hostname);
      const list = good && addrs.some((a) => a.address === good)
        ? [addrs.find((a) => a.address === good), ...addrs.filter((a) => a.address !== good)]
        : addrs;
      if (opts && opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };

  const connector = buildConnector({
    lookup,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: ATTEMPT_TIMEOUT_MS,
    timeout: CONNECT_TIMEOUT_MS,
  });

  return (opts, cb) => connector(opts, (err, socket) => {
    if (!err && socket?.remoteAddress && opts.hostname) {
      preferredAddress.set(opts.hostname, socket.remoteAddress.replace(/^::ffff:/, ''));
    }
    cb(err, socket);
  });
}

export function createAgent(resolveAll) {
  return new Agent({ connect: createConnect(resolveAll) });
}

/** Подключает перебор адресов ко всем запросам приложения (глобальный fetch). */
export function installNetwork() {
  setGlobalDispatcher(createAgent());
  globalThis.fetch = undiciFetch;
}
