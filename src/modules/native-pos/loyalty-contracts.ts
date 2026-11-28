import type {NativeCustomer} from './contracts';
export interface NativeCustomerDetail {customer:NativeCustomer & {pointsBalance:number};canLedger:boolean;ledger:{id:string;type:string;pointsDelta:number;reason:string|null;orderNumber?:string|null;createdAt:string}[]}
export interface NativeReceiptClaim {orderId:string;claim:{points:number;expiresAt:string;imageUri:string}|null;error:string|null}
