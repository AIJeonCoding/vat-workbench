import type { EntityManager } from '@mikro-orm/postgresql';
import { AuditLog } from '../domain/entities';
import type { Actor } from '../domain/schemas';

export function audit(em: EntityManager, actor: Actor | string, entity: string, entityId: number, action: string, before?: unknown, after?: unknown) {
  const a = new AuditLog();
  a.actor = typeof actor === 'string' ? actor : `${actor.role}:${actor.userId}`;
  a.entity = entity;
  a.entityId = entityId;
  a.action = action;
  a.before = before ?? null;
  a.after = after ?? null;
  em.persist(a);
}
