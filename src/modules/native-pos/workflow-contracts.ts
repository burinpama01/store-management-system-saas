import type { NativeLine, NativeOrder } from './contracts';
export interface NativeCashSession { id: string; status: string; openingSatang: number; expectedSatang: number | null; openedAt: string; closingSatang?: number; varianceSatang?: number }
export interface NativeTicket { id: string; label: string; updatedAt: string; totalSatang: number; lineCount: number; resumable: boolean; blockedReason?: string }
export type NativeSavedTicket = NativeTicket;
export interface NativeTicketResume { id: string; label: string; lines: NativeLine[]; checkoutOperationId: string }
export interface NativeOrderDetail extends NativeOrder { subtotalSatang: number; discountSatang: number; note?: string; payments: { method: string; status: string; amountSatang: number; receivedSatang?: number; changeSatang?: number }[] }
