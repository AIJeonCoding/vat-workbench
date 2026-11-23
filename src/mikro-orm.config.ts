import { defineConfig } from '@mikro-orm/postgresql';
import { ENTITIES } from './domain/entities';

export const ormConfig = () =>
  defineConfig({
    clientUrl: process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5433/vat',
    entities: ENTITIES,
    debug: false,
  });
