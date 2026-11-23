import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';

export type WorkbenchEvent =
  | { type: 'txn'; filingId: number; txnId: number }
  | { type: 'summary'; filingId: number }
  | { type: 'agentStep'; filingId: number; txnId: number; tool: string; summary: string }
  | { type: 'file'; filingId: number; fileId: number };

/** 서비스가 변경을 알리면 GraphQL subscription이 다른 사용자 화면으로 중계한다. */
@Injectable()
export class EventBus {
  private readonly em = new EventEmitter().setMaxListeners(100);

  emit(e: WorkbenchEvent) {
    this.em.emit('event', e);
  }

  on(fn: (e: WorkbenchEvent) => void): () => void {
    this.em.on('event', fn);
    return () => this.em.off('event', fn);
  }
}
