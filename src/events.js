import { EventEmitter } from 'node:events';

/** Внутренняя шина событий: изменения подборок для живого обновления вкладок сотрудников. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitSelectionChange(s, kind) {
  bus.emit('selection', {
    memberId: s.member_id, entityType: s.entity_type, entityId: s.entity_id, selectionId: s.id, kind,
  });
}
