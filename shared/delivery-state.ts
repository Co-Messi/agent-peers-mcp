export interface PendingAck {
  messageId: number;
  token: string;
}

export class PendingAckQueue {
  private readonly byMessageId = new Map<number, string>();

  constructor(private readonly batchSize: number) {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new Error("invalid ack batch size");
  }

  get size(): number { return this.byMessageId.size; }

  enqueue(messageId: number, token: string): void {
    this.byMessageId.set(messageId, token);
  }

  nextBatch(): PendingAck[] {
    return Array.from(this.byMessageId, ([messageId, token]) => ({ messageId, token }))
      .slice(0, this.batchSize);
  }

  confirm(batch: PendingAck[]): void {
    for (const item of batch) {
      if (this.byMessageId.get(item.messageId) === item.token) this.byMessageId.delete(item.messageId);
    }
  }
}
