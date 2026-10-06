import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NativeCashSession, NativeSavedTicket, NativeTicketResume } from '../../../src/modules/native-pos/workflow-contracts';
import type { NativeLine } from '../../../src/modules/native-pos/contracts';
export function createDemoWorkflow() {
  const storageKey='storeos.demo.workflow.v1';
  type State={cash:NativeCashSession|null;tickets:Record<string,NativeSavedTicket & {lines:NativeLine[]}>;claims:Record<string,NativeTicketResume>};
  let state:State|undefined;
  return async function request<T>(operation:string,body?:unknown):Promise<T>{
    if(!state){try{state=JSON.parse(await AsyncStorage.getItem(storageKey) ?? 'null') as State;}catch{} state ??= {cash:null,tickets:{},claims:{}};}
    const input=body as any; let result:unknown; const name=operation.split('?')[0];
    if(name==='cash-session')result={session:state.cash?.status==='open'?state.cash:null,canRecord:true};
    else if(name==='cash-open'){if(state.cash?.status==='open')throw new Error('มีกะสาธิตเปิดอยู่แล้ว');state.cash={id:'demo-cash',status:'open',openedAt:new Date().toISOString(),openingSatang:input.openingSatang,expectedSatang:input.openingSatang};result={session:state.cash};}
    else if(name==='cash-close'){if(!state.cash||state.cash.id!==input.sessionId||state.cash.status!=='open')throw new Error('ไม่พบกะสาธิต');state.cash={...state.cash,status:'closed',closingSatang:input.closingSatang,varianceSatang:input.closingSatang-(state.cash.expectedSatang??0)};result={session:state.cash};}
    else if(name==='tickets')result={tickets:Object.values(state.tickets)};
    else if(name==='ticket-save'){if(Object.values(state.claims).some(c=>c.id===input.id))throw new Error('บิลสาธิตนี้เรียกกลับไปแล้ว');state.tickets[input.id]??={id:input.id,label:input.label,updatedAt:new Date().toISOString(),totalSatang:input.expectedTotalSatang,lineCount:input.lines.length,resumable:true,lines:input.lines};result={ticket:state.tickets[input.id]};}
    else if(name==='ticket-resume'){if(!state.claims[input.claimId]){const ticket=state.tickets[input.id];if(!ticket||ticket.updatedAt!==input.updatedAt)throw new Error('บิลสาธิตเปลี่ยนหรือถูกเรียกไปแล้ว');state.claims[input.claimId]={id:ticket.id,label:ticket.label,lines:ticket.lines,checkoutOperationId:input.claimId};delete state.tickets[input.id];}result=state.claims[input.claimId];}
    else if(name==='history')result={orders:[{id:'demo-order',number:'DEMO-001',status:'paid',totalSatang:8500,createdAt:new Date().toISOString(),lines:[{key:'demo-line',productId:'demo-product',name:'รายการสาธิต',quantity:1,unitSatang:8500,variantId:null,optionIds:[],note:''}]}]};
    else if(name==='order-detail')result={order:{id:'demo-order',number:'DEMO-001',status:'paid',subtotalSatang:8500,discountSatang:0,totalSatang:8500,createdAt:new Date().toISOString(),lines:[{key:'demo-line',productId:'demo-product',name:'รายการสาธิต',quantity:1,unitSatang:8500,variantId:null,optionIds:[],note:''}],payments:[{method:'cash',status:'completed',amountSatang:8500,receivedSatang:10000,changeSatang:1500}]}};
    else throw new Error('ไม่พบฟังก์ชันสาธิต');
    await AsyncStorage.setItem(storageKey,JSON.stringify(state));return result as T;
  };
}
